// Image loading for canvas scenes: every image a scene draws is decoded before the frame renders.
import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";

const cache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = cache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const im = new Image();
      im.decoding = "sync";
      im.onload = () => im.decode().then(() => resolve(im), () => resolve(im));
      im.onerror = () => reject(new Error(`image failed: ${src}`));
      im.src = src;
    });
    cache.set(src, p);
  }
  return p;
}

/** Load public files (paths relative to public/) and hold the render until they are decoded. */
export function useImages(paths: string[]): Record<string, HTMLImageElement> | null {
  const key = paths.join("|");
  const [imgs, setImgs] = useState<Record<string, HTMLImageElement> | null>(null);
  const [handle] = useState(() => delayRender(`images ${paths.length}`, { timeoutInMilliseconds: 120000 }));
  useEffect(() => {
    let live = true;
    Promise.all(paths.map((p) => loadImage(staticFile(p))))
      .then((list) => {
        if (!live) return;
        setImgs(Object.fromEntries(paths.map((p, i) => [p, list[i]])));
        continueRender(handle);
      })
      .catch((e) => {
        console.error(e);
        continueRender(handle);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return imgs;
}
