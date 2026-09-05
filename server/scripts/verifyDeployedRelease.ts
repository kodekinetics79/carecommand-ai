import { verifyDeployedRelease } from './verifyDeployedReleaseCore';

async function main(): Promise<void> {
  const result = await verifyDeployedRelease({
    acknowledgement: process.env.DEPLOYED_RELEASE_VERIFY_ACK,
    baseUrl: process.env.DEPLOYED_RELEASE_BASE_URL,
    expectedSha: process.env.DEPLOYED_RELEASE_EXPECTED_SHA,
    metricsToken: process.env.DEPLOYED_RELEASE_METRICS_TOKEN,
  });
  console.log(`CareCommand deployed release PASS: ${JSON.stringify(result)}`);
}

main().catch(error => {
  console.error(`CareCommand deployed release FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
