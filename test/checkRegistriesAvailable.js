import https from 'https';

function checkUrl(url) {
  console.log(`Checking URL: ${url}`);
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      // ✅ Consume the response to free up the socket:
      res.on('data', () => {}); // discard data
      res.on('end', () => {
        resolve(res.statusCode === 200);
      });
    });
    req.on('error', (err) => {
      console.error(`❌ Error checking URL: ${url}`, err.message);
      resolve(false);
    });
    req.end();
  });
}

async function main() {
  const registries = [
    'https://packages.fhir.org/hl7.fhir.r4.core',
    'https://packages.simplifier.net/hl7.fhir.r4.core/-/hl7.fhir.r4.core-4.0.1.tgz'
  ];

  const results = await Promise.all(registries.map(checkUrl));
  const allAvailable = results.every((r) => r === true);

  if (!allAvailable) {
    console.error('❌ One or more registries are not available. Aborting tests.');
    process.exit(1);
  } else {
    console.log('✅ Registries are available.');
    process.exit(0); // ✅ clean exit
  }
}

main();
