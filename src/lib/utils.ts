import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * The app's type scale (globals.css: text-display … text-mono-small) sets font size, so tailwind-merge must treat it as a font size. Unknown, it reads
 * `text-caption` as a colour and drops it whenever a colour class such as `text-muted-foreground` follows.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["display", "heading-1", "heading-2", "heading-3", "body", "body-small", "caption", "mono", "mono-small"] },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
