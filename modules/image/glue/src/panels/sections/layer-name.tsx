// A layer's name in a layer row, renamed in place: double-click (or Enter /
// F2 on the focused name) swaps the name for a text field; Enter or leaving
// the field commits, Escape gives the old name back. Focus returns to the
// name when the field closes. It replaces a `window.prompt`, which blocked
// the page, could not be styled or localised and is refused in an embedded
// frame.

import { useEffect, useRef, useState } from "react";

export function LayerName({
  name,
  label,
  title,
  dimmed = false,
  onRename,
}: {
  name: string;
  /** The field's accessible name ("Layer name"). */
  label: string;
  title?: string;
  /** A hidden layer's name is shown faded. */
  dimmed?: boolean;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = useRef<HTMLSpanElement | null>(null);
  // Focus goes back to the name only after an edit ended, not on mount.
  const refocus = useRef(false);
  // One end per edit: the blur that follows the field's removal is not a
  // second commit.
  const open = useRef(false);
  useEffect(() => {
    if (draft !== null || !refocus.current) return;
    refocus.current = false;
    shown.current?.focus({ preventScroll: true });
  }, [draft]);

  const begin = () => {
    open.current = true;
    setDraft(name);
  };
  const end = (commit: boolean, viaKey: boolean) => {
    if (draft === null || !open.current) return;
    open.current = false;
    refocus.current = viaKey;
    const next = draft.trim();
    setDraft(null);
    if (commit && next !== "" && next !== name) onRename(next);
  };

  if (draft !== null) {
    return (
      <input
        type="text"
        data-image-layer-rename
        aria-label={label}
        // The field exists because the user asked to rename: it takes focus.
        autoFocus
        value={draft}
        style={{ flex: 1, minWidth: 0, font: "inherit" }}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => end(true, false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            end(true, true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            end(false, true);
          }
        }}
      />
    );
  }
  return (
    <span
      ref={shown}
      role="button"
      tabIndex={0}
      data-image-layer-name
      style={{
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        opacity: dimmed ? 0.5 : 1,
      }}
      title={title}
      onDoubleClick={begin}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          begin();
        }
      }}
    >
      {name}
    </span>
  );
}
