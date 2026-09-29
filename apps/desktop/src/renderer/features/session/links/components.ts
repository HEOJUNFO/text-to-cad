import { PathLink } from "./PathLink";
import { TranscriptImage } from "./TranscriptImage";

/**
 * What the transcript's markdown draws its own way — prose and thoughts
 * alike: a link through `PathLink`, an image through `TranscriptImage`. A
 * module constant, because `MessageResponse` is memoised on its children and
 * a fresh object per render would rebuild every block.
 */
export const TRANSCRIPT_COMPONENTS = { a: PathLink, img: TranscriptImage };
