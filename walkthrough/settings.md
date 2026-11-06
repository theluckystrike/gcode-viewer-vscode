# Settings

- `gcodeViewer.filamentDiameter` and `gcodeViewer.filamentDensity` set the weight estimate (1.75 mm and 1.24 g/cm³, PLA, by default).
- `gcodeViewer.maxFileMB` (500 by default) is the largest file that is read. Bigger files show a message and are not read.
- `gcodeViewer.maxMoves` (5,000,000 by default) caps the moves drawn in 3D. Stats always cover the whole file.
- `gcodeViewer.rapidFeed` is the G0 speed used in the CNC time estimate.
- `gcodeViewer.mode` reads every file as 3D print or CNC instead of choosing per file.
