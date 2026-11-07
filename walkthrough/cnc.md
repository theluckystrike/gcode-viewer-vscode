# CNC programs

Files ending in .nc, .ngc, .tap and .cnc open in CNC mode, and so does any file with no extrusion moves.

- Rapids (G0), cuts (G1), arcs (G2 and G3, including helical arcs and R arcs) and plunges each get their own color.
- The slider steps through Z passes. Color by tool, feed rate or Z pass from the Color menu.
- The stats show the cycle time estimate, cut length, rapid length, tools and spindle speed.
- The "3D print / CNC" menu reads the file again in the other mode.

NetCDF data files also end in .nc, so .nc files open in GCode Viewer only when you right-click them and pick "Open in GCode Viewer". You can make it the default with "Open With..." and "Configure default editor for '*.nc'...".

A .nc file that is really a NetCDF data file gets a short message and a button to reopen it in another editor.
