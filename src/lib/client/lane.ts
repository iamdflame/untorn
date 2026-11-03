// The links in the submission and the README carry ?for=judges: live runs started from them draw on the share of each
// judging day's spend cap kept for judges (src/lib/server/limits.ts), so a busy day elsewhere can't use up a judge's
// live run. Kept for the tab's session, since the page drops the query once a visitor moves on.

const KEY = "untorn-lane";

const asked = (search: string) => new URLSearchParams(search).get("for") === "judges";

/** Note the judges' link when the page opens on it. */
export function rememberLane(search = typeof window === "undefined" ? "" : window.location.search): void {
  if (!asked(search)) return;
  try {
    sessionStorage.setItem(KEY, "judges");
  } catch {
    // storage blocked: lane() still reads the address bar
  }
}

/** "judges" when this tab came in through the judges' link. */
export function lane(): "judges" | undefined {
  if (typeof window === "undefined") return undefined;
  if (asked(window.location.search)) return "judges";
  try {
    return sessionStorage.getItem(KEY) === "judges" ? "judges" : undefined;
  } catch {
    return undefined;
  }
}
