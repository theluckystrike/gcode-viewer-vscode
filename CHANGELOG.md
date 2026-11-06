# Changelog

## 0.1.0 (2026-11-06)

- First release.
- 3D toolpath preview for .gcode, .gco and .nc files, plus .g, .ngc, .tap and .cnc through "Open in GCode Viewer".
- Color by feature (read from the slicer's TYPE comments), speed or layer. CNC files color rapids, cuts, arcs and plunges, or each tool.
- Layer and Z pass slider, one-layer view, travel toggle, playback with a nozzle marker at 1× to 5000×.
- Stats show layers, moves, print or cycle time from feed rates, filament length and weight, size, speeds, tools and the slicer's own estimates.
- Go to line for a layer or for a clicked move. The view reloads when the file changes on disk.
- Files are read in a worker thread. Files over 500 MB show a message and are not read.
- Sponsor and More free viewers links at the bottom of the viewer (setting gcodeViewer.showSupportLinks).
