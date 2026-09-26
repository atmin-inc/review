// Adapted from shadcn/ui (MIT). See ../../UPSTREAM.json and ../../LICENSE.shadcn.
"use client";
import { cn } from "../lib/utils.js";
import { Separator as SeparatorPrimitive } from "radix-ui";
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}) {
  return <SeparatorPrimitive.Root
    data-slot="separator"
    decorative={decorative}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
      className
    )}
    {...props}
  />;
}
export {
  Separator
};
