/** One hue per plan, shared by the bill timeline and the pricing views so a plan looks the same in both. */
export const planColors = ["#4e7eaf", "#a47553", "#8874b4", "#4b908d", "#ba7187", "#7f8e49"] as const;

export const planColor = (index: number) => planColors[((index % planColors.length) + planColors.length) % planColors.length]!;
