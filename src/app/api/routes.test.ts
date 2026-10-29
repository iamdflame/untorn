// Route tests: the real handlers, an in-memory store and mocked models (no network, no Blob).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent, RunResult } from "@/lib/run/types";
import { fakeDeps, fakeScene } from "@/lib/server/__tests__/fake-run";
import { resetLimits } from "@/lib/server/limits";
import { resetSessions } from "@/lib/server/sessions";
import { memoryStore, setStore, type Store } from "@/lib/server/store";

const fake = vi.hoisted(() => ({ opts: {} as Record<string, unknown> }));
vi.mock("@/lib/server/live", () => ({
  liveDeps: (put: Parameters<typeof fakeDeps>[0]) => fakeDeps(put, fake.opts),
}));

import { POST as postRun } from "./runs/route";
import { GET as getRun } from "./runs/[runId]/route";
import { GET as getFile } from "./files/[...key]/route";
import { POST as postSession } from "./sessions/route";
import { GET as getSessionRoute } from "./sessions/[code]/route";
import { POST as postSessionPhoto } from "./sessions/[code]/photo/route";
import { GET as getHealth } from "./health/route";
import { POST as postHealthRun } from "./health/run/route";
import { GET as getCleanup } from "./cleanup/route";

const ctx = <T extends Record<string, string | string[]>>(params: T) => ({ params: Promise.resolve(params) }) as never;

function uploadRequest(bytes: Uint8Array, ip = "203.0.113.7", name = "photo.png") {
  const form = new FormData();
  form.set("photo", new Blob([Buffer.from(bytes)]), name);
  return new Request("http://localhost/api/runs", { method: "POST", body: form, headers: { "x-forwarded-for": ip } });
}

async function readEvents(res: Response): Promise<RunEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent);
}

let store: Store;
beforeEach(() => {
  store = memoryStore();
  setStore(store);
  resetLimits();
  resetSessions();
  fake.opts = {};
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("POST /api/runs", () => {
  it("streams a whole run for an upload and stores it for replay", async () => {
    const scene = await fakeScene();
    const res = await postRun(uploadRequest(scene.photo));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = await readEvents(res);
    expect(events[0].type).toBe("start");
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    const result = (done as { result: RunResult }).result;
    expect(result.source).toBe("upload");
    expect(result.photo.url).toBe(`/api/files/runs/${result.runId}/photo.jpg`);

    const stored = await getRun(new Request(`http://localhost/api/runs/${result.runId}`), ctx({ runId: result.runId }));
    expect(stored.status).toBe(200);
    expect(((await stored.json()) as RunResult).pieces).toHaveLength(6);

    const photo = await getFile(new Request("http://localhost/x"), ctx({ key: ["runs", result.runId, "photo.jpg"] }));
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    const page = await getFile(new Request("http://localhost/x?download=1"), ctx({ key: ["runs", result.runId, "page-0.png"] }));
    expect(page.headers.get("content-disposition")).toContain("attachment");
    // the spend ledger settled the run
    expect((await store.list("ledger/")).some((f) => f.key.endsWith(".d"))).toBe(true);
  });

  it("rejects a file that isn't an image, whatever its name says", async () => {
    const res = await postRun(uploadRequest(new TextEncoder().encode("<script>alert(1)</script> not a photo at all"), "203.0.113.8", "../../evil.jpg"));
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string; recover: string[] } };
    expect(body.error.code).toBe("bad-type");
    expect(body.error.recover.length).toBeGreaterThan(0);
  });

  it("rejects an oversized upload before reading it", async () => {
    const req = new Request("http://localhost/api/runs", { method: "POST", body: "x", headers: { "content-length": String(20 * 1024 * 1024), "content-type": "multipart/form-data; boundary=x" } });
    const res = await postRun(req);
    expect(res.status).toBe(413);
  });

  it("rejects a photo too small to measure", async () => {
    const sharp = (await import("sharp")).default;
    const tiny = new Uint8Array(await sharp({ create: { width: 300, height: 200, channels: 3, background: "#777" } }).jpeg().toBuffer());
    const res = await postRun(uploadRequest(tiny, "203.0.113.9", "tiny.jpg"));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("too-small");
  });

  it("limits runs per address", async () => {
    vi.stubEnv("RUNS_PER_IP_PER_HOUR", "1");
    const scene = await fakeScene();
    const first = await postRun(uploadRequest(scene.photo, "198.51.100.1"));
    await first.text();
    const second = await postRun(uploadRequest(scene.photo, "198.51.100.1"));
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("rate-limited");
    const other = await postRun(uploadRequest(scene.photo, "198.51.100.2"));
    expect(other.status).toBe(200);
    await other.text();
  });

  it("stops live runs at the daily spend cap", async () => {
    vi.stubEnv("DAILY_SPEND_CAP_USD", "0.1");
    const scene = await fakeScene();
    const res = await postRun(uploadRequest(scene.photo));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("daily-cap");
  });

  it("sends a designed error event, never a stack trace, when SAM fails mid-stream", async () => {
    fake.opts = { segment: "fail" };
    const scene = await fakeScene();
    const events = await readEvents(await postRun(uploadRequest(scene.photo)));
    const err = events.at(-1) as Extract<RunEvent, { type: "error" }>;
    expect(err.type).toBe("error");
    expect(err.code).toBe("model-error");
    expect(err.message).not.toMatch(/at .*\.ts:\d+/);
  });

  it("says when no paper is found", async () => {
    fake.opts = { segment: "empty" };
    const scene = await fakeScene();
    const events = await readEvents(await postRun(uploadRequest(scene.photo)));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "no-pieces" });
  });

  it("runs the bundled sample by name", async () => {
    const res = await postRun(new Request("http://localhost/api/runs", { method: "POST", body: JSON.stringify({ sample: "chouteau-1903" }), headers: { "content-type": "application/json" } }));
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ type: "start", source: "sample" });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("404s an unknown run, sample or file path", async () => {
    expect((await getRun(new Request("http://localhost/x"), ctx({ runId: "nosuchrun123" }))).status).toBe(404);
    expect((await getFile(new Request("http://localhost/x"), ctx({ key: ["photos", "abcdefghijkmnpqr"] }))).status).toBe(404);
    const res = await postRun(new Request("http://localhost/api/runs", { method: "POST", body: JSON.stringify({ sample: "../../etc/passwd" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(404);
  });
});

describe("phone handoff", () => {
  it("code → phone photo → laptop sees it → run on the photo id", async () => {
    const created = await postSession(new Request("http://localhost/api/sessions", { method: "POST" }));
    const { code, url } = (await created.json()) as { code: string; url: string };
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(url).toBe(`http://localhost/c/${code}`);

    const waiting = await (await getSessionRoute(new Request("http://localhost/x"), ctx({ code }))).json();
    expect(waiting).toMatchObject({ status: "waiting" });

    const scene = await fakeScene();
    const form = new FormData();
    form.set("photo", new Blob([Buffer.from(scene.photo)]), "IMG_0001.png");
    const up = await postSessionPhoto(new Request(`http://localhost/api/sessions/${code}/photo`, { method: "POST", body: form }), ctx({ code }));
    expect(up.status).toBe(200);

    const ready = (await (await getSessionRoute(new Request("http://localhost/x"), ctx({ code: code.toLowerCase() }))).json()) as { status: string; photoId: string };
    expect(ready.status).toBe("photo");

    const res = await postRun(new Request("http://localhost/api/runs", { method: "POST", body: JSON.stringify({ photoId: ready.photoId }), headers: { "content-type": "application/json" } }));
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ type: "start", source: "phone" });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("refuses a non-image from the phone, an unknown code and an expired one", async () => {
    const { code } = (await (await postSession(new Request("http://localhost/api/sessions", { method: "POST" }))).json()) as { code: string };
    const bad = await postSessionPhoto(new Request(`http://localhost/api/sessions/${code}/photo`, { method: "POST", body: "GIF89a nope nope nope" }), ctx({ code }));
    expect(bad.status).toBe(415);
    expect((await getSessionRoute(new Request("http://localhost/x"), ctx({ code: "ZZZZZZ" }))).status).toBe(404);
    expect((await getSessionRoute(new Request("http://localhost/x"), ctx({ code: "bad code!" }))).status).toBe(404);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 60_000);
    expect(await (await getSessionRoute(new Request("http://localhost/x"), ctx({ code }))).json()).toMatchObject({ status: "expired" });
    const scene = await fakeScene();
    const late = await postSessionPhoto(new Request(`http://localhost/api/sessions/${code}/photo`, { method: "POST", body: Buffer.from(scene.photo) }), ctx({ code }));
    expect(late.status).toBe(410);
  });

  it("rate-limits code creation per address", async () => {
    vi.stubEnv("SESSIONS_PER_IP_PER_HOUR", "2");
    const make = () => postSession(new Request("http://localhost/api/sessions", { method: "POST", headers: { "x-forwarded-for": "192.0.2.5" } }));
    expect((await make()).status).toBe(200);
    expect((await make()).status).toBe(200);
    expect((await make()).status).toBe(429);
  });
});

describe("ops", () => {
  it("health run needs the cron secret, records the sample's score, and /api/health reports it", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    expect((await postHealthRun(new Request("http://localhost/api/health/run", { method: "POST" }))).status).toBe(401);
    const res = await postHealthRun(new Request("http://localhost/api/health/run", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    const rec = (await res.json()) as { ok: boolean; score: { pieces: number } | null; problem?: string };
    // mocked SAM returns the synthetic scene, not the sample letter: the score check must fail, loudly
    expect(res.status).toBe(503);
    expect(rec.ok).toBe(false);
    expect(rec.score?.pieces).toBe(6);
    const health = (await (await getHealth(new Request("http://localhost/api/health"))).json()) as { lastRun: { ok: boolean } | null; pipeline: string };
    expect(health.lastRun?.ok).toBe(false);
    expect(health.pipeline).toBe("unknown");
    expect(await (await getHealth(new Request("http://localhost/api/health?warm=1"))).json()).toEqual({ ok: true });
  });

  it("cleanup deletes photos and runs older than a day, and needs the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "s");
    expect((await getCleanup(new Request("http://localhost/api/cleanup"))).status).toBe(401);
    await store.put("photos/aaaaaaaaaaaaaaaa", new Uint8Array([1]), "image/jpeg");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 3600_000);
    await store.put("photos/bbbbbbbbbbbbbbbb", new Uint8Array([1]), "image/jpeg");
    const res = await getCleanup(new Request("http://localhost/api/cleanup", { headers: { authorization: "Bearer s" } }));
    expect(((await res.json()) as { deleted: Record<string, number> }).deleted["photos/"]).toBe(1);
    expect(await store.exists("photos/aaaaaaaaaaaaaaaa")).toBe(false);
    expect(await store.exists("photos/bbbbbbbbbbbbbbbb")).toBe(true);
  });
});
