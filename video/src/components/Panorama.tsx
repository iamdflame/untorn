// A real perspective camera inside an equirectangular 360° photograph (WebGL2): yaw, pitch, roll and field of view
// per frame, so the archive shots are true camera moves rather than a flat pan over a picture. A gentle grade sits the
// photograph in the room's palette (exposure, saturation, warmth), and nothing is invented: it samples the original.
import React, { useLayoutEffect, useRef } from "react";
import { continueRender, delayRender, staticFile } from "remotion";
import { loadImage } from "../lib/images";
import { H, W } from "../theme";

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D tex; uniform vec2 res;
uniform float yaw, pitch, roll, fov, exposure, sat, warm, vignette;
out vec4 o;
void main(){
  vec2 q = gl_FragCoord.xy - 0.5 * res; q.y = -q.y;
  float f = 0.5 * res.x / tan(0.5 * fov);
  vec3 d = normalize(vec3(q.x, q.y, f));
  float cr = cos(roll), sr = sin(roll); d = vec3(cr * d.x - sr * d.y, sr * d.x + cr * d.y, d.z);
  float cp = cos(pitch), sp = sin(pitch); d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float cy = cos(yaw), sy = sin(yaw); d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
  float lon = atan(d.x, d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  vec2 uv = vec2(0.5 + lon / 6.28318530718, 0.5 + lat / 3.14159265359);
  vec3 c = texture(tex, uv).rgb;
  c = pow(c, vec3(2.2)) * exposure;                       // linear light
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, sat);
  c *= mix(vec3(1.0), vec3(1.06, 1.0, 0.9), warm);        // warm the light toward the room
  vec2 n = gl_FragCoord.xy / res - 0.5;
  c *= 1.0 - vignette * smoothstep(0.25, 0.85, length(n * vec2(1.0, 1.25)));
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  o = vec4(c, 1.0);
}`;

export type PanoView = { yaw: number; pitch: number; fov: number; roll?: number; exposure?: number; sat?: number; warm?: number; vignette?: number };

type GLState = { gl: WebGL2RenderingContext; prog: WebGLProgram; ready: boolean; loading: boolean; view: PanoView };
const states = new WeakMap<HTMLCanvasElement, GLState>();

export const Panorama: React.FC<{ src: string; view: PanoView; style?: React.CSSProperties }> = ({ src, view: viewProp, style }) => {
  let view = viewProp;
  const ref = useRef<HTMLCanvasElement>(null);
  const handle = useRef<number | null>(null);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let st = states.get(cv);
    const drawNow = (s: GLState) => {
      const { gl, prog } = s;
      const view = s.view;
      gl.viewport(0, 0, W, H);
      gl.useProgram(prog);
      const u = (n: string) => gl.getUniformLocation(prog, n);
      const r = Math.PI / 180;
      gl.uniform2f(u("res"), W, H);
      gl.uniform1f(u("yaw"), view.yaw * r);
      gl.uniform1f(u("pitch"), view.pitch * r);
      gl.uniform1f(u("roll"), (view.roll ?? 0) * r);
      gl.uniform1f(u("fov"), view.fov * r);
      gl.uniform1f(u("exposure"), view.exposure ?? 1);
      gl.uniform1f(u("sat"), view.sat ?? 1);
      gl.uniform1f(u("warm"), view.warm ?? 0);
      gl.uniform1f(u("vignette"), view.vignette ?? 0.35);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.finish();
    };
    if (st) st.view = view;
    if (st?.ready) {
      drawNow(st);
      return;
    }
    if (st?.loading) return;
    if (!st) {
      const gl = cv.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false })!;
      const sh = (type: number, srcCode: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, srcCode);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
        return s;
      };
      const prog = gl.createProgram()!;
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      st = { gl, prog, ready: false, loading: false, view };
      states.set(cv, st);
    }
    const s = st;
    s.loading = true;
    handle.current = delayRender(`panorama ${src}`, { timeoutInMilliseconds: 120000 });
    loadImage(staticFile(src)).then((im) => {
      const { gl } = s;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      s.ready = true;
      s.loading = false;
      view = s.view;
      drawNow(s);
      if (handle.current !== null) continueRender(handle.current);
      handle.current = null;
    });
  });
  return <canvas ref={ref} width={W} height={H} style={{ position: "absolute", left: 0, top: 0, width: W, height: H, ...style }} />;
};
