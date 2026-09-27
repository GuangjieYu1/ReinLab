# Third-party acknowledgements

## React Bits
BlurText, TiltedCard and ShinyText are copied from David Haz's React Bits
TypeScript/CSS sources. Used for heading reveals, archive tilt and activity text.

- Source: https://github.com/DavidHDev/react-bits
- Reference commit: 9481af758aae6cfb34c3652ec40a1c099360331f
- Retrieved: 2026-09-21
- License: MIT + Commons Clause; the complete notice is in `licenses/react-bits.txt`.
- These three components use Motion / DOM / CSS only, not WebGL.

## RhineLabUI reference motion

The complete opening timing functions and array motion functions in
`src/components/cinematic/reference/` are reproduced from the public RhineLab
blog theme, derived from LBEILC/RhineLabUI.

- Source: https://github.com/JesseLee-CN/rhinelab-blog-theme
- Reference commit: 0d6d6981b4b1a616964a3f1ddc1131e5dea55e65
- Upstream: https://github.com/LBEILC/RhineLabUI
- Copyright (c) 2026 LBEILC
- License for program code: MIT, complete notice in `licenses/rhinelab-ui.txt`.
- Reference copies used during motion inspection are in `reference/rhinelab/`.
- The camera equations are adapted to a DOM/CSS perspective matrix. No Three.js
  code, WebGL renderer, GLB models, shaders or original film are used at runtime.
- `BootStage.tsx` adapts the shared logo path and SVG drawing logic from the
  reference's `brand.ts` / `boot.ts`. The cinematic naming and emblem are
  unofficial fan-design references to Rhine Lab. The upstream MIT code license
  does not automatically license third-party trademarks or game artwork.
- The cassette SVG and CSS six-face geometry are original approximations.
- No reference film audio or video is imported into the website build.
- The ambient soundtrack in `AmbientScore.ts` is an original procedural
  composition rendered with Web Audio. It contains no third-party samples.
- `cassette-array.svg` and the additional CSS optical/material layers are
  original lightweight visual approximations, not extracted video assets.

This is an unofficial Rhine Lab-inspired design study, not an official
Arknights or DeepSeek product.

## AI research laboratory visual reference

The research laboratory's shared-state / discussion / experiment-lane
composition was visually informed by the 01:25–01:35 segment of the Bilibili
video provided by the user:
https://www.bilibili.com/video/BV1eFVS6YEat/

The user-requested ten-second MP4 in `reference-clips/` is local design
reference material, not application code, not imported by the site, and
excluded from Git by `.gitignore`. Its source video and audio remain the
original creator's work. The research laboratory UI, SVG graphics, interaction
logic, and fixed example data are our own implementation; no AutoScientists
code or video assets are bundled into the production app.

## Classroom geometry and media

- `d3-geo` 3.1.1 and `topojson-client` 3.1.0 are bundled for SVG globe projection.
  Their dependencies `d3-array` and `internmap` are also bundled. Full notices
  copied from the installed packages are in `licenses/learning-libraries.txt`.
- Land geometry: `world-atlas@2.0.2/land-110m.json`, derived from Natural Earth.
  Source: https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json
- Modern reference city coordinates (Athens, Nicosia, Beirut, Cairo):
  https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_populated_places.geojson
- Geographic sources are for location only. The red example line is an authored
  classroom discussion path, not a sourced archaeological reconstruction.
- Mathematics content is an original adaptation informed by MIT ES.268's group
  theory lecture organization. No MIT slides are bundled or sold as original work:
  https://ocw.mit.edu/courses/es-268-the-mathematics-in-toys-and-games-spring-2010/resources/mites_268s10_ses6_slides/
- `public/classroom/guitar-four-beats.mp4`, `guitar-a.wav` and `guitar-b.wav`
  are original synthetic fretboard/tonal demonstrations. No real student audio,
  guitar recordings, external instructional videos, or third-party samples are used.
- The photography studies are original editable SVG lighting diagrams, not
  photographs or images of a real person.
- tldraw Agent and alphaTab were design references only; neither SDK is installed
  or bundled. This frontend does not claim a production tldraw license.
