// Force jsPDF default to be the constructor for tsx CJS interop
const jspdfMod = await import('jspdf');
if (typeof jspdfMod.default === 'function' && jspdfMod.default.prototype?.constructor !== jspdfMod.default) {
  // no-op — already correct in prod
}
// Simple hack: replace the module cache entry
import { Module } from 'node:module';
// Just re-map:
const gen = await import('./src/lib/document-generator.server.ts');
import fs from 'node:fs';
const md = `# Stereoscopic Cameras Comparison\n\nTest.\n\n| Model | Approach | Resolution | Depth | Notes |\n|---|---|---|---|---|\n| ZED 2i | Passive stereo IMU+SLAM | 4416 × 1242 | 0.2 m – 40 m | Longer baseline → better long-range; needs dust housing for harsh mines. |\n| RealSense D455 | Active stereo IR | 1280 × 720 | 0.4 m – 10 m | Longer baseline → better long-range among D4xx; IR helps in dark shafts. |\n| RealSense D457 | Active stereo | 1280 × 720 | 0.4 m – 12 m | Improved IR robustness; still sensitive to airborne particulates. |\n| Ensenso N35 | Active projected pattern | 5 MP | 0.2 m – 10 m | Industrial IP-rated packages available; projector helps with textureless surfaces. |\n| Photoneo MotionCam-3D | High-speed active | Varies | 0.2 m – 10 m | Motion + cluttered scenes; needs protective enclosure for dust/water. |\n| Bumblebee2 | Passive stereo | 1024 × 768 | 0.5 m – 20 m | Field robotics classic; requires rugged housing and external lighting. |\n| Basler GigE | Custom pair | 1920 × 1200 | 0.1 m – 20+ m | Flexible — choose sensors, global shutter, lenses, and rugged housings. |\n| Lucid Vision Helios/Atlas | Custom industrial | Up to 12 MP | 0.1 m – >20 m | High-res sensors + global shutter; pair with lighting and IP67 enclosure. |\n`;
const r = await gen.generateDocument({ format: 'pdf', title: 'Stereoscopic Cameras Comparison', markdown: md });
fs.writeFileSync('/tmp/test.pdf', r.bytes);
console.log('ok', r.bytes.length);
