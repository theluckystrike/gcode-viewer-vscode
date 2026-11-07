# GCode Viewer & 3D Print Preview

See your 3D printer or CNC G-code as a 3D toolpath in VS Code, layer by layer, and find the exact line behind any move.

![GCode Viewer showing a cube print colored by feature, with the layer slider, the stats panel and the legend](images/cube-feature.png)

*Screenshot of VS Code 1.142 with a cube print made by `scripts/make-samples.js`.*

- Check a slice before it goes to the printer. Walls, infill, skin, skirt and support each get a color, and the slider steps through every layer.
- Get the print time, filament length and weight, size and speeds from the file itself, next to the slicer's own estimate when the file has one.
- Click any move to see its line number, then open the text at that line. It works for CNC programs too, with G2 and G3 arcs and Z passes.

## Quick start

1. Install the extension.
2. Click a `.gcode` or `.gco` file in the Explorer. For `.nc`, `.g`, `.ngc`, `.tap` and `.cnc`, right-click the file and pick "Open in GCode Viewer".

## What you can do

| Action | How |
|---|---|
| Orbit, pan, zoom | Drag, right-drag, scroll. Fit, 3D, Top and Front in the toolbar. |
| Step through layers | The Layer slider, or the Up and Down keys. Home and End jump to the first and last layer. |
| Show one layer | One layer (or the S key). |
| Show travel moves | Travel (or T). In CNC mode the button is called Rapids and starts on. |
| Color the toolpath | Pick Feature, Speed or Layer in the Color menu. CNC files offer Move type, Feed rate, Z pass and Tool. |
| Play the print | Play (or Space) draws the moves in order with a nozzle marker, at 1× to 5000× speed. Drag the progress bar to seek. |
| Find a line | Go to line opens the text beside the preview at the first line of the layer. Click a move to see its line, then jump to it. |
| Copy the stats | Copy in the Stats panel. |

![Go to line opened the text beside the preview at the first line of layer 42](images/go-to-line.png)

![Playback at 60× speed with the nozzle marker drawing one of the first layers](images/playing.png)

![Spiral vase colored by speed, with the speed scale in the legend](images/vase-speed.png)

![CNC pocket program in CNC mode, with rapids, cuts, arcs and plunges in their own colors](images/cnc-pocket.png)

## What the stats show

- Layers (from slicer comments such as `;LAYER:`, `;LAYER_CHANGE` or `; CHANGE_LAYER`, or from Z heights when there are none), lines, moves and arcs.
- Print time estimated from the feed rate of every move, plus dwells. Acceleration is not modelled, so real prints often take a little longer. When the slicer wrote its own estimate (Cura `;TIME:`, PrusaSlicer, OrcaSlicer or Bambu Studio footers), it is shown too.
- Filament length from the E axis (absolute or relative) and the weight for the filament diameter and density in the settings.
- Size and X, Y and Z ranges of the printed part, the speed range, retractions and temperatures.
- In CNC mode the cycle time, cut and rapid lengths, the tools and the spindle speed.

## CNC mode

`.nc`, `.ngc`, `.tap` and `.cnc` files open in CNC mode, and so does any file with no extrusion. G0 rapids, G1 cuts, G2 and G3 arcs (I, J, K or R, helical arcs, G17, G18 and G19 planes) and plunges each get a color. Inches (G20), relative moves (G91), G92 and G28 are handled. The slider steps through Z passes. The 3D print / CNC menu reads the file again in the other mode.

NetCDF data files also end in `.nc`, so GCode Viewer does not take over `.nc` files by default. To open all your `.nc` files in it, right-click one, pick "Open With...", then "Configure default editor for '*.nc'..." and choose GCode Viewer. A `.nc` file that is really a NetCDF data file gets a short message and a button to reopen it in another editor.

## Big files

The file is read in a worker thread in 4 MB chunks, so VS Code stays responsive. In the release check a 59 MB file with 1.5 million moves was drawn 2.0 seconds after it was opened, and the workbench never took more than 30 ms to answer while it was read. Files over 500 MB show a message and are not read (setting `gcodeViewer.maxFileMB`). At most 5 million moves are drawn (setting `gcodeViewer.maxMoves`), while the stats still cover the whole file. The view reads the file again when it changes on disk, for example after the slicer exports it again.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `gcodeViewer.mode` | `auto` | Read files as 3D print or CNC, or choose per file. |
| `gcodeViewer.filamentDiameter` | `1.75` | Filament diameter in mm for the weight estimate. |
| `gcodeViewer.filamentDensity` | `1.24` | Filament density in g/cm³ (PLA 1.24, PETG 1.27, ABS 1.04). |
| `gcodeViewer.rapidFeed` | `5000` | G0 speed in mm/min for the CNC time estimate. |
| `gcodeViewer.maxFileMB` | `500` | Largest file that is read. |
| `gcodeViewer.maxMoves` | `5000000` | Most moves drawn in 3D. |
| `gcodeViewer.askForRating` | `true` | Ask one time for a Marketplace rating after a few days of use. |
| `gcodeViewer.showSupportLinks` | `true` | Show the small Sponsor and More free viewers links under the view. |

## Privacy

Everything runs on your machine. The extension makes no network calls and has no telemetry. The webview runs under a strict Content Security Policy with no remote scripts, and comment text from the file is shown as plain text. The G-code file is never changed.

## Limits

- Lines are drawn 1 pixel wide, not as round extrusion tubes.
- Time estimates use feed rates only, without acceleration, jerk or firmware limits.
- Binary G-code (`.bgcode`) is not read. Export plain text G-code from the slicer instead.
- Picking a move uses the visible lines, so very dense views can pick a neighbour. Zoom in or use One layer for an exact pick.

## Support

Zovo extensions have no ads and no tracking, and sponsors pay for the time that goes into fixes and new viewers. You can sponsor the work on [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

## More viewers by Zovo

- [DXF Viewer & CAD Viewer for 2D Drawings](https://marketplace.visualstudio.com/items?itemName=zovo.dxf-viewer) opens ASCII and binary DXF drawings with layers, measuring and PNG or SVG export.
- [PDF Viewer & PDF Reader with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.pdf-viewer-dark) reads PDFs with a real dark mode, search, an outline and thumbnails.
- [CSV Viewer, Excel Viewer & Parquet Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode) opens CSV, TSV, Excel and Parquet files as a sortable, filterable table.
- [DOCX Viewer & Word Viewer with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word and ODT files with dark mode, an outline and search.
- [PPTX Viewer & PowerPoint Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.pptx-slide-viewer) shows PowerPoint slides, thumbnails and speaker notes.
- [Large JSON Viewer & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [JSONL Viewer & NDJSON Table Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [SQLite Viewer & DB Viewer (Read-Only)](https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.
- [HDF5 & NetCDF Explorer (H5 Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.hdf5-netcdf-explorer) browses groups, attributes and values in HDF5 and NetCDF files and plots slices.
- [GGUF, Safetensors & NPY Viewer (NumPy Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) shows NPY, NPZ, Safetensors and GGUF tensors with stats and heatmaps.
- [MP4 Video Player & Video Preview with Sound](https://marketplace.visualstudio.com/items?itemName=zovo.video-preview-with-sound) plays MP4, MOV, MKV and WebM files with their sound.
- [AGENTS.md & CLAUDE.md Linter (Context Drift)](https://marketplace.visualstudio.com/items?itemName=zovo.context-drift) finds stale commands, paths and versions in AGENTS.md and CLAUDE.md files.
- [Agent Skills & Claude Skills (Skill Shelf)](https://marketplace.visualstudio.com/items?itemName=zovo.skill-shelf) lists, checks and toggles the Agent Skills that Claude Code, Codex and Cursor load.
- [Claude Code History & Codex History Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.agent-session-viewer) browses and searches your local Claude Code and Codex sessions.
- [Claude Code Usage & Codex Usage Cost Meter](https://marketplace.visualstudio.com/items?itemName=zovo.ai-usage-meter) shows Claude Code and Codex tokens and estimated cost from your local session files.

Coming soon to the Marketplace, with the code on GitHub now.

- [3D Model Viewer (GLB, glTF, STL, OBJ, PLY)](https://github.com/theluckystrike/model-viewer-vscode) views GLB, glTF, STL, OBJ, PLY and 3MF models.
- [Audio Preview & Loudness Meter](https://github.com/theluckystrike/audio-preview-vscode) plays audio files with a waveform, a spectrogram and LUFS loudness.
- [Graphviz Preview & DOT Viewer](https://github.com/theluckystrike/graphviz-preview-vscode) shows a live preview of DOT files and exports SVG or PNG.
- [TIFF Viewer (16-bit, Float, GeoTIFF)](https://github.com/theluckystrike/tiff-viewer-vscode) opens 16-bit, float, multi-page and GeoTIFF images.
- [Avro Viewer, Arrow Viewer & Feather Viewer](https://github.com/theluckystrike/arrow-avro-viewer-vscode) opens Avro, Arrow and Feather files as a paged table.
- [EML Viewer & MBOX Email Viewer](https://github.com/theluckystrike/eml-viewer-vscode) reads EML, EMLX and MBOX email files with remote images blocked.
- [PKL Viewer & Pickle Viewer](https://github.com/theluckystrike/pickle-viewer-vscode) opens Python pickle files without Python and never runs their code.
- [DICOM Viewer & NIfTI Viewer for CT and MRI](https://github.com/theluckystrike/dicom-nifti-viewer-vscode) opens CT and MRI scans, DICOM folders and NIfTI volumes with window presets and three views.
- [ZIP Viewer & Archive Explorer (JAR, TAR, GZ)](https://github.com/theluckystrike/archive-explorer-vscode) browses ZIP, JAR, VSIX, TAR and GZ files, opens entries in tabs and extracts them safely.
- [EPUB Reader & EPUB Viewer](https://github.com/theluckystrike/epub-reader-vscode) reads EPUB books with a table of contents, search and light, sepia or dark themes.
- [File Viewers Pack](https://github.com/theluckystrike/zovo-file-viewers) installs the PDF, table, Word, PowerPoint, HDF5 and tensor viewers in one step.

## License

MIT. three.js is MIT licensed, see THIRD-PARTY-NOTICES.md.
