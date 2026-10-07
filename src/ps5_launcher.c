#include <stdio.h>

#include "piou.h"
#include "ps5_launcher.h"

extern int sceSystemServiceLaunchWebBrowser(const char *uri);

int ps5_launch_browser(const char *uri) {
  piou_log("[PIOU] Launching browser: %s\n", uri);
  if (sceSystemServiceLaunchWebBrowser(uri) != 0) {
    piou_notify("PIOU: Failed to launch browser.");
    return -1;
  }
  return 0;
}
