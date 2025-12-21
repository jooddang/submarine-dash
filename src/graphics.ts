// Graphics Helper Functions

export const interpolateColor = (start: number[], end: number[], factor: number): string => {
  const result = start.map((startVal, i) => {
    const endVal = end[i];
    return Math.round(startVal + (endVal - startVal) * factor);
  });
  return `rgb(${result[0]}, ${result[1]}, ${result[2]})`;
};
