# Changelog

## 0.1.1 (2026-11-08)

- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.
- The "More free viewers" list and the README now use the current Marketplace names and include the newest Zovo extensions: ZIP, GCode, EPUB, HAR, font and audio viewers.

## 0.1.0 (2026-11-06)

- First release.
- 3D toolpath preview for .gcode and .gco files, plus .nc, .g, .ngc, .tap and .cnc through "Open in GCode Viewer". NetCDF data files also use .nc, so GCode Viewer does not claim it as the default editor.
- Color by feature (read from the slicer's TYPE comments), speed or layer. CNC files color rapids, cuts, arcs and plunges, or each tool.
- Layer and Z pass slider, one-layer view, travel toggle, playback with a nozzle marker at 1× to 5000×.
- Stats show layers, moves, print or cycle time from feed rates, filament length and weight, size, speeds, tools and the slicer's own estimates.
- Go to line for a layer or for a clicked move. The view reloads when the file changes on disk.
- Files are read in a worker thread. Files over 500 MB show a message and are not read.
- Sponsor and More free viewers links at the bottom of the viewer (setting gcodeViewer.showSupportLinks).
- The "More free viewers" list and the README list now show the 15 Zovo extensions on the Marketplace under their current names, and 11 that are coming soon.
- Extensions for related files now come first, starting with DXF Viewer & CAD Viewer for 2D Drawings.
