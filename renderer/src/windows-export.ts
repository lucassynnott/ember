import { ExportFrameCompositor, trackSample } from './windows-export-compositor'
// The export window's compositor entry. The streaming transport is supplied by main.
Object.assign(window, { emberExport: { ExportFrameCompositor, trackSample } })
