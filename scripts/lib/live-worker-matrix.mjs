export function classifyMatrixOutcome({
  interrupted,
  allSuccessful,
  fixtureIdentityValid,
  comparisons,
  expectedRouteCount,
}) {
  if (interrupted) {
    return { status: "interrupted", executionStatus: "interrupted", comparisonStatus: "not_established" };
  }
  if (!allSuccessful || !fixtureIdentityValid) {
    return { status: "completed_with_failures", executionStatus: "failed", comparisonStatus: "not_established" };
  }
  const comparisonSufficient = Array.isArray(comparisons)
    && comparisons.length === expectedRouteCount
    && comparisons.every((item) => item?.sufficientData === true
      && item.comparisonRouteCount === expectedRouteCount);
  return comparisonSufficient
    ? { status: "passed", executionStatus: "passed", comparisonStatus: "sufficient" }
    : {
        status: "execution_passed_comparison_insufficient",
        executionStatus: "passed",
        comparisonStatus: "insufficient_data",
      };
}
