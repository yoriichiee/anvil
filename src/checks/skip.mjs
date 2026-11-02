// throw skip('why') from a check's run(ctx) to mark it skipped; the reason is listed under notChecked
export class SkipCheck extends Error {}
export const skip = why => new SkipCheck(why);
