import type { WebColorTokens } from "@rakazo/ui-tokens";
import { webTokensForAppearance } from "@rakazo/ui-tokens";
import type { PrismTheme, Token } from "prism-react-renderer";
import { Highlight, Prism } from "prism-react-renderer";
import { Fragment } from "react";
import { useWebAppearance } from "./appearance.web";

function codeTheme(palette: WebColorTokens): PrismTheme {
  return {
    plain: { color: palette.foreground, backgroundColor: "transparent" },
    styles: [
      {
        types: ["comment", "prolog", "doctype", "cdata"],
        style: { color: palette.mutedForeground },
      },
      { types: ["punctuation", "operator"], style: { color: palette.faintForeground } },
      {
        types: ["keyword", "selector", "builtin", "important", "atrule"],
        style: { color: palette.link },
      },
      {
        types: ["string", "char", "attr-value", "regex"],
        style: { color: palette.success },
      },
      { types: ["number", "boolean", "constant", "symbol"], style: { color: palette.warning } },
      {
        types: ["function", "class-name", "tag"],
        style: { color: palette.foreground, fontWeight: "600" },
      },
    ],
  };
}

function isBlankLine(line: readonly Token[]): boolean {
  return line.length === 1 && line[0]?.empty === true;
}

/**
 * A fence's code with token colours. The text is drawn exactly as written, so the copy button
 * still reads the source, and a language Prism does not know stays a plain block.
 */
export default function HighlightedCode({ code, language }: { code: string; language: string }) {
  const appearance = useWebAppearance();
  if (!Prism.languages[language.toLowerCase()]) return <code>{code}</code>;
  return (
    <Highlight
      theme={codeTheme(webTokensForAppearance(appearance))}
      code={code}
      language={language}
    >
      {({ tokens, getTokenProps }) => (
        <code>
          {tokens.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} {...getTokenProps({ token })} />
              ))}
              {lineIndex < tokens.length - 1 && !isBlankLine(tokens[lineIndex + 1]!) ? "\n" : null}
            </Fragment>
          ))}
        </code>
      )}
    </Highlight>
  );
}
