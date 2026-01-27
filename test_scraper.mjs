import { scrapeUserComments } from './server/twitterScraper.ts';

async function test() {
  try {
    console.log('Starting test...');
    const result = await scrapeUserComments('elonmusk', 1);
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

test();
