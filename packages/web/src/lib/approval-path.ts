const LAST_APPROVAL_PATH_STORAGE_KEY = "remi.last-approval-path";

export function getStoredApprovalPath(pathname?: string) {
  if (pathname === "/approval/anchors" || pathname === "/approval/probes") {
    return pathname;
  }

  const stored = window.localStorage.getItem(LAST_APPROVAL_PATH_STORAGE_KEY);
  return stored === "/approval/probes" || stored === "/approval/anchors"
    ? stored
    : "/approval/anchors";
}

export { LAST_APPROVAL_PATH_STORAGE_KEY };
