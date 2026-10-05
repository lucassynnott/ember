/** A figure drawn on the Hairline engine: what the onboarding's stage mounts. */
export interface HairlineFigure {
  name: string
  means: string
  rules: number[]
  range: [number, number, number]
  mount(
    host: { stage: HTMLElement; svg: SVGSVGElement; read: HTMLElement },
    value: number,
  ): { set(value: number): void; destroy(): void }
}
