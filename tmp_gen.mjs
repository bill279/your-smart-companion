const mod = await import('jspdf');
console.log('default:', typeof mod.default, 'jsPDF:', typeof mod.jsPDF);
const jsPDF = mod.jsPDF ?? mod.default;
const gen = await import('./src/lib/document-generator.server.ts');
import fs from 'node:fs';
const md = `# Stereoscopic Cameras Comparison

Test doc.

| Model | Approach | Resolution | Depth | Notes |
|---|---|---|---|---|
| ZED 2i | Passive stereo IMU+SLAM | 4416 × 1242 | 0.2 m – 40 m | Longer baseline → better long-range; needs dust housing. |
| RealSense D455 | Active stereo IR | 1280 × 720 | 0.4 m – 10 m | Longer baseline → better long-range among D4xx; IR helps in dark shafts. |
| RealSense D457 | Active stereo | 1280 × 720 | 0.4 m – 12 m | Improved IR robustness. |
| Ensenso N35 | Active projected pattern | 5 MP | 0.2 m – 10 m | Industrial IP-rated. |
| Photoneo MotionCam-3D | High-speed active | Varies | 0.2 m – 10 m | Motion + cluttered scenes. |
| Bumblebee2 | Passive stereo | 1024 × 768 | 0.5 m – 20 m | Field robotics classic. |
| Basler GigE | Custom pair | 1920 × 1200 | 0.1 m – 20+ m | Flexible bespoke rigs. |
| Lucid Vision Helios/Atlas | Custom industrial | Up to 12 MP | 0.1 m – >20 m | High-res + global shutter. |
`;
const r = await gen.generateDocument({ format: 'pdf', title: 'Stereoscopic Cameras Comparison', markdown: md });
fs.writeFileSync('/tmp/test.pdf', r.bytes);
console.log('ok', r.bytes.length);
