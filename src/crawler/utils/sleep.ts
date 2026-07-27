import { sleep } from "bun";

function getRandomInt(min: number, max: number): number {
  const floorMin = Math.floor(min);
  const floorMax = Math.floor(max);
  return Math.floor(Math.random() * (floorMax - floorMin + 1)) + floorMin;
}

/** 随机暂停2-8秒 */
export function sleepRandom2000To8000() {
  return sleep(getRandomInt(2000, 8000));
}
