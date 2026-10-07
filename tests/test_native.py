import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class NativeTests(unittest.TestCase):
    def test_generated_registry_binary_search(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            dist = root / "dist"
            dist.mkdir()
            (dist / "VERSION").write_text("test")
            for name in ("index.html", "a.txt", "z.txt", "middle.txt"):
                (dist / name).write_text(name)
            subprocess.run(["python3", str(ROOT / "tools/gen_file_registry.py"),
                            str(dist), str(root / "file_registry.h"),
                            str(root / "file_registry.c")], check=True)
            harness = root / "test.c"
            harness.write_text('''
#include <assert.h>
#include <stddef.h>
#include "file_registry.h"
int main(void) {
    for (unsigned int i = 0; i < file_registry_count; i++)
        assert(file_registry_find(file_registry[i].path) == &file_registry[i]);
    assert(!file_registry_find(NULL));
    assert(!file_registry_find(""));
    assert(!file_registry_find("/missing"));
    assert(!file_registry_find("zzzz"));
    return 0;
}
''')
            binary = root / "registry-test"
            subprocess.run(["cc", "-Wall", "-Wextra", "-Werror", str(harness),
                            str(root / "file_registry.c"), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)

    def test_log_wraparound_and_stale_cursor(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / "piou_version.h").write_text(
                '#define PIOU_FULL_VERSION "test"\n#define PIOU_BUILD_TIME "test"\n')
            harness = root / "test.c"
            harness.write_text('''
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "piou.h"
int main(void) {
    assert(freopen("/dev/null", "w", stdout));
    char chunk[501]; memset(chunk, 'x', 500); chunk[500] = 0;
    for (int i = 0; i < 300; i++) piou_log("%s", chunk);
    size_t pos = 0, total = 0, count;
    char output[4096];
    while ((count = piou_wait_logs(&pos, output, sizeof(output))) != 0) {
        total += count;
        for (size_t i = 0; i < count; i++) assert(output[i] == 'x');
    }
    assert(total == 128 * 1024);
    assert(pos == 150000);
    pos = 999999;
    assert(piou_wait_logs(&pos, output, sizeof(output)) == sizeof(output));
    assert(pos == 150000 - 128 * 1024 + sizeof(output));
    return 0;
}
''')
            binary = root / "log-test"
            subprocess.run(["cc", "-Wall", "-Wextra", "-Werror", "-pthread",
                            "-I", str(root), "-I", str(ROOT / "include"),
                            str(harness), str(ROOT / "src/log.c"), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=5)
