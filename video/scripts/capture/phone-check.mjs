// Re-shoots the phone's "Check the photo" screen of a captured run (capture/<GOLDEN_DIR>/phone/phone-2-check.png) on
// the live phone page with the same code and photo. For a run whose photo was a HEIC: the capture's headless Chromium
// can't draw HEIC, so its preview came out blank; an iPhone's browser hands the page a JPEG (and Safari draws HEIC
// anyway). The run's code has since expired, so only the page's code check is answered "waiting"; the page itself is
// the live one.
//   APP_URL=https://untorn.vercel.app GOLDEN_DIR=golden-real node scripts/capture/phone-check.mjs <code> <photo.jpg>
import path from "node:path";
import { devices } from "playwright";
import { APP, CAPTURE, launch } from "./lib.mjs";

const [code, photo] = process.argv.slice(2);
const OUT = path.join(CAPTURE, process.env.GOLDEN_DIR ?? "golden", "phone", "phone-2-check.png");
const browser = await launch();
const ph = await browser.newContext({ ...devices["iPhone 15 Pro"], viewport: { width: 393, height: 852 }, colorScheme: "dark", locale: "en-GB", timezoneId: "UTC" });
const phone = await ph.newPage();
await phone.route(`**/api/sessions/${code}`, (r) => (r.request().method() === "GET" ? r.fulfill({ json: { code, status: "waiting" } }) : r.continue()));
await phone.goto(`${APP}/c/${code}`, { waitUntil: "load" });
await phone.getByText("One photo of the torn pieces").waitFor({ timeout: 20000 });
await phone.locator('input[type="file"]').setInputFiles(path.resolve(photo));
await phone.getByText("Check the photo").waitFor({ timeout: 20000 });
await phone.waitForFunction(() => document.querySelector(".capture-preview")?.naturalWidth > 0, null, { timeout: 20000 });
await phone.waitForTimeout(600);
await phone.screenshot({ path: OUT });
console.log(OUT);
await browser.close();
