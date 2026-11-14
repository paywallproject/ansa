/**
 * The phone layout: a narrow screen, or a phone on its side (a touch screen too short for the folder list
 * beside the conversations). The same test as Tailwind's `phone` and `md` variants in index.css.
 */
export const PHONE = 'not all and (min-width: 768px) and ((pointer: fine) or (min-height: 500px))'

export const isPhone = () => window.matchMedia(PHONE).matches
