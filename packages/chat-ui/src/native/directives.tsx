import type { MarkdownStyleMap } from "@ronradtke/react-native-markdown-display";
import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CalloutVariant } from "../directives";

export function NativeCallout({
  title,
  variant,
  styleMap,
  children,
}: {
  title?: string;
  variant: CalloutVariant;
  styleMap: MarkdownStyleMap;
  children: ReactNode;
}) {
  return (
    <View style={[styleMap.blockquote, styleMap[`callout_${variant}`]]}>
      {title ? <Text style={styleMap.strong}>{title}</Text> : null}
      {children}
    </View>
  );
}

/** A titled block the reader opens, closed by default like the web details element. */
export function NativeCollapsible({
  title,
  styleMap,
  children,
}: {
  title: string;
  styleMap: MarkdownStyleMap;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styleMap.blockquote}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        onPress={() => setOpen((value) => !value)}
      >
        <Text style={styleMap.strong}>{open ? `▾ ${title}` : `▸ ${title}`}</Text>
      </Pressable>
      {open ? <View style={styleMap.directive_body}>{children}</View> : null}
    </View>
  );
}
