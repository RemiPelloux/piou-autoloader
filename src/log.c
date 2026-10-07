#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <sys/time.h>
#include <errno.h>

#include "piou.h"

#define LOG_BUFFER_SIZE (128 * 1024)

/* Ring buffer.
 *
 * The log is consumed by the installer page as a byte stream addressed by an
 * absolute offset. A plain append-only buffer used to fill up after ~128 KiB
 * and then silently stop logging — and worse, block every waiter forever
 * because the "new data" condition could never be satisfied again. We instead
 * keep the most recent LOG_BUFFER_SIZE bytes plus a monotonic write counter:
 *
 *   log_written  total bytes ever appended (never decreases)
 *   log_base     absolute offset of the oldest byte still in the ring
 *   log_start    index of the oldest byte inside log_ring
 *   log_size     number of valid bytes currently held in log_ring
 *
 * Readers ask for an absolute offset. If it has already been overwritten we
 * snap forward to log_base, so a slow client resumes at the oldest available
 * data instead of getting stuck. */
static char log_ring[LOG_BUFFER_SIZE];
static size_t log_written = 0;
static size_t log_base = 0;
static size_t log_start = 0;
static size_t log_size = 0;

static pthread_mutex_t log_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t log_cond = PTHREAD_COND_INITIALIZER;

/* Append len bytes to the ring, dropping the oldest data as needed. */
static void log_append_locked(const char *data, size_t len) {
    if (len >= LOG_BUFFER_SIZE) {
        /* The chunk alone overflows the whole buffer: keep only its tail. */
        data += len - LOG_BUFFER_SIZE;
        len = LOG_BUFFER_SIZE;
        log_start = 0;
        log_size = LOG_BUFFER_SIZE;
        memcpy(log_ring, data, LOG_BUFFER_SIZE);
        log_written += len;
        log_base = log_written - log_size;
        return;
    }

    /* Make room: drop the oldest bytes. */
    size_t overflow = (log_size + len > LOG_BUFFER_SIZE)
        ? (log_size + len - LOG_BUFFER_SIZE) : 0;
    log_start = (log_start + overflow) % LOG_BUFFER_SIZE;
    log_size -= overflow;

    /* Copy into the ring, splitting on wrap-around. */
    size_t write_at = (log_start + log_size) % LOG_BUFFER_SIZE;
    size_t first = LOG_BUFFER_SIZE - write_at;
    if (first > len) first = len;
    memcpy(log_ring + write_at, data, first);
    if (len > first) {
        memcpy(log_ring, data + first, len - first);
    }
    log_size += len;
    log_written += len;
    log_base = log_written - log_size;
}

void piou_log(const char *fmt, ...) {
    char temp[512];
    va_list args;

    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);

    va_start(args, fmt);
    int len = vsnprintf(temp, sizeof(temp), fmt, args);
    va_end(args);

    if (len > 0) {
        /* vsnprintf reports the length it *would* have written, so clamp to
           what actually fits in temp before copying. */
        size_t n = (size_t)len;
        if (n > sizeof(temp) - 1) n = sizeof(temp) - 1;

        pthread_mutex_lock(&log_mutex);
        log_append_locked(temp, n);
        pthread_cond_broadcast(&log_cond);
        pthread_mutex_unlock(&log_mutex);
    }
}

/* Wait for new logs starting from *pos. Copies up to max_len into out_buf.
 * Returns the number of bytes copied. Blocks up to 1 second.
 *
 * *pos is an absolute stream offset: if it points at data that has since been
 * overwritten, it is advanced to the oldest byte still buffered. */
size_t piou_wait_logs(size_t *pos, char *out_buf, size_t max_len) {
    pthread_mutex_lock(&log_mutex);

    struct timeval tv;
    struct timespec ts;
    gettimeofday(&tv, NULL);
    ts.tv_sec = tv.tv_sec + 1;
    ts.tv_nsec = tv.tv_usec * 1000;

    while (*pos >= log_written) {
        int rc = pthread_cond_timedwait(&log_cond, &log_mutex, &ts);
        if (rc == ETIMEDOUT) {
            break;
        }
    }

    /* Slow client: its offset fell out of the ring. Resume at the oldest
       available byte rather than pretending no data exists. */
    if (*pos < log_base) {
        *pos = log_base;
    }

    size_t copied = 0;
    if (*pos < log_written) {
        copied = log_written - *pos;
        if (copied > max_len) copied = max_len;

        size_t offset = (log_start + (*pos - log_base)) % LOG_BUFFER_SIZE;
        size_t first = LOG_BUFFER_SIZE - offset;
        if (first > copied) first = copied;
        memcpy(out_buf, log_ring + offset, first);
        if (copied > first) {
            memcpy(out_buf + first, log_ring, copied - first);
        }
        *pos += copied;
    }

    pthread_mutex_unlock(&log_mutex);
    return copied;
}

void piou_log_wakeup(void) {
    pthread_mutex_lock(&log_mutex);
    pthread_cond_broadcast(&log_cond);
    pthread_mutex_unlock(&log_mutex);
}
