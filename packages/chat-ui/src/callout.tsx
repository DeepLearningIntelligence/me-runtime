import type { ReactNode } from "react";
import type { CalloutVariant } from "./directives";

function CalloutIcon({ variant }: { variant: CalloutVariant }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {variant === "success" ? (
        <>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="m7.5 12 3 3 6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : variant === "warning" ? (
        <>
          <path
            d="M12 3.5 21 20H3z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinejoin="round"
          />
          <path d="M12 9v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="17" r="1" fill="currentColor" />
        </>
      ) : variant === "tip" ? (
        <>
          <path
            d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4.9 1 .9 1.7V16h5.2v-.4c0-.7.3-1.3.9-1.7A6 6 0 0 0 12 3Z"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
          <path d="M12 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="7.5" r="1" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** A short aside the reader must not miss. Its children are drawn by the markdown renderer. */
export function Callout({
  variant,
  title,
  children,
}: {
  variant: CalloutVariant;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`rk-chat-callout rk-chat-callout-${variant}`} role="note">
      <span className="rk-chat-callout-icon">
        <CalloutIcon variant={variant} />
      </span>
      <div className="rk-chat-callout-body">
        {title ? <p className="rk-chat-callout-title">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
