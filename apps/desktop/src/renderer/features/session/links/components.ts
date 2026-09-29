import type { ReactNode } from "react";

import { PathLink } from "./PathLink";
import { TranscriptImage } from "./TranscriptImage";

/**
 * What the transcript's markdown draws its own way — prose and thoughts
 * alike: a link through `PathLink`, an image through `TranscriptImage`. A
 * module constant, because `MessageResponse` is memoised on its children and
 * a fresh object per render would rebuild every block.
 *
 * `<picture>` and `<source>` pass Streamdown's sanitizer, and `srcset` is
 * checked against no protocol list: a `<source srcset="https://…">` beside a
 * project image the transcript does draw is a request on paint, the browser
 * preferring the source to its `<img>`. So a source draws nothing and a
 * picture is only its children.
 */
export const TRANSCRIPT_COMPONENTS = {
  a: PathLink,
  img: TranscriptImage,
  picture: ({ children }: { children?: ReactNode }) => children,
  source: () => null,
};
