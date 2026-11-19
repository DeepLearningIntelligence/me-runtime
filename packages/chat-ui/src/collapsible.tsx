import type { ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import { useMarkdownCopy } from "./markdown-copy";

/** Open details, kept by the message so a streamed update does not close what the reader opened. */
export const CollapsibleOpenContext = createContext<{
  open(id: string): boolean;
  toggle(id: string): void;
} | null>(null);

/** A details block, closed until the reader opens it. */
export function Collapsible({
  id,
  title,
  children,
}: {
  id: string;
  title?: string;
  children?: ReactNode;
}) {
  const copy = useMarkdownCopy();
  const store = useContext(CollapsibleOpenContext);
  const [localOpen, setLocalOpen] = useState(false);
  const open = store ? store.open(id) : localOpen;
  return (
    <details className="rk-chat-collapsible" open={open}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary is details' control. */}
      <summary
        onClick={(event) => {
          event.preventDefault();
          if (store) store.toggle(id);
          else setLocalOpen((value) => !value);
        }}
      >
        {title ?? copy.details}
      </summary>
      {children}
    </details>
  );
}
