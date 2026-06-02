// Test stub for @nativescript/canvas (the real module uses platform-specific native resolution that
// can't load under jsdom). The app helper value-imports `Canvas` to construct a view; tests pass
// their own mock canvas to Canvas()/createRoot, so this only needs to exist for the import.
export class Canvas {
  setInlineStyle() {}
  on() {}
}
