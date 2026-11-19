/**
 * Links and text dropped on the feed, attached to the next message. One helper
 * owns how a dropped entry reads as a chip, so the composer and the transcript
 * show the same label.
 */

/** A short chip label: the host and path for a URL, else the text itself. */
export function attachedLinkLabel(link: string): string {
  try {
    const url = new URL(link);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const path = url.pathname === "/" ? "" : url.pathname;
      return `${url.hostname.replace(/^www\./, "")}${path}${url.search}`;
    }
  } catch {
    // Not a URL, so the dropped text stands as its own label.
  }
  return link.length > 80 ? `${link.slice(0, 77)}...` : link;
}

/**
 * The entries a drop carries: one per line of `text/uri-list`, then of plain
 * text, de-duplicated. A drop of files alone carries nothing here; files keep
 * their own attachment path.
 */
export function droppedLinks(data: DataTransfer): string[] {
  const raw = [data.getData("text/uri-list"), data.getData("text/plain")]
    .filter(Boolean)
    .join("\n");
  return [
    ...new Set(
      raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .slice(0, 20),
    ),
  ];
}
