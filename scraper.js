import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendDiscordNotification } from './notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Manually load environment variables from .env if it exists (no npm dependency needed)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('=');
    const key = parts[0].trim();
    const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

// 2. Load configuration
const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const allowedBedrooms = config.filters?.bedrooms || [1, 2];
const minPrice = config.filters?.minPrice || 0;
const maxPrice = config.filters?.maxPrice || 99999;
const ignoreMonths = config.filters?.ignoreMonths || [];

// 3. Load seen listings database
const seenListingsPath = path.join(__dirname, 'seen_listings.json');
let seenListings = {};
let isFirstRun = false;

if (fs.existsSync(seenListingsPath)) {
  try {
    const rawData = JSON.parse(fs.readFileSync(seenListingsPath, 'utf8'));
    if (Array.isArray(rawData)) {
      console.log('Migrating seen_listings.json from array to object map.');
      for (const id of rawData) {
        seenListings[id] = 0; // Unknown previous price
      }
    } else {
      seenListings = rawData;
    }
    console.log(`Loaded ${Object.keys(seenListings).length} previously seen listings.`);
    if (Object.keys(seenListings).length === 0) {
      console.log('Database is empty. Setting to first run configuration.');
      isFirstRun = true;
    }
  } catch (err) {
    console.error('Error parsing seen_listings.json, starting fresh:', err.message);
    isFirstRun = true;
  }
} else {
  console.log('No seen_listings.json found. This is the first run (initializing database).');
  isFirstRun = true;
}

// Helper: Extract community metadata from HTML page
async function getCommunityMetadata(url) {
  console.log(`Fetching page metadata: ${url}`);
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch page. Status: ${response.status}`);
  }

  const html = await response.text();
  const communityIdMatch = html.match(/'communityId':\s*'([^']+)'/) || html.match(/"communityId":\s*"([^"]+)"/);
  const communityNameMatch = html.match(/'community':\s*'([^']+)'/) || html.match(/"community":\s*"([^"]+)"/);

  if (!communityIdMatch) {
    throw new Error(`Could not find communityId in HTML for URL: ${url}`);
  }

  return {
    communityId: communityIdMatch[1],
    communityName: communityNameMatch ? communityNameMatch[1] : communityIdMatch[1]
  };
}

// Helper: Fetch units from API
async function fetchUnits(communityId, refererUrl) {
  const queryObj = {
    arcSite: 'avalon-communities',
    communityId: communityId,
    isMoveInDateFlexible: true,
    showFavorites: false,
    sortBy: 'LowestPrice',
    unitHasPromotion: false
  };
  const queryStr = encodeURIComponent(JSON.stringify(queryObj));
  const apiUrl = `https://www.avaloncommunities.com/pf/api/v3/content/fetch/community-units?query=${queryStr}&_website=avalon-communities`;

  console.log(`Fetching units API for ${communityId}`);
  const response = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': refererUrl
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch units API. Status: ${response.status}`);
  }

  const data = await response.json();
  return Object.values(data.units || {});
}

// Send initialization summary to Discord so user knows bot is alive
async function sendInitNotification(webhookUrl, initialCount) {
  if (!webhookUrl) return;
  const payload = {
    username: 'Avalon Bot',
    avatar_url: 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=128&h=128&fit=crop',
    embeds: [{
      title: '🚀 Avalon Apartment Bot Initialized!',
      description: `The bot is now running and tracking listings.\n\n• **Target Sites**: ${config.targets.map(t => t.name).join(', ')}\n• **Filters**: 1-Bedroom and 2-Bedroom apartments\n• **Initial Listings Tracked**: ${initialCount}\n\nYou will receive a notification here whenever a new listing matching these criteria is posted.`,
      color: 3066993, // Green 0x2ECC71
      timestamp: new Date().toISOString()
    }]
  };
  
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log('Initialization notification sent to Discord.');
  } catch (err) {
    console.error('Failed to send initialization notification:', err);
  }
}

async function main() {
  if (!webhookUrl) {
    console.warn('⚠️ WARNING: DISCORD_WEBHOOK_URL is not configured in environment or .env!');
  }

  let allScrapedUnits = {};
  let newUnits = [];

  for (const target of config.targets) {
    try {
      // 1. Get community metadata
      const { communityId, communityName } = await getCommunityMetadata(target.url);
      console.log(`Processing: ${communityName} (ID: ${communityId})`);

      // 2. Fetch all current units
      const units = await fetchUnits(communityId, target.url);
      console.log(`Total units available on site: ${units.length}`);

      // 3. Filter units (beds, budget, date)
      const filteredUnits = units.filter(unit => {
        if (!allowedBedrooms.includes(unit.bedroomNumber)) return false;
        
        const price = unit.startingAtPricesUnfurnished?.prices?.totalPrice || unit.startingAtPricesUnfurnished?.prices?.price;
        if (price && (price < minPrice || price > maxPrice)) return false;

        if (unit.availableDateUnfurnished && ignoreMonths.length > 0) {
          const date = new Date(unit.availableDateUnfurnished);
          if (ignoreMonths.includes(date.getMonth() + 1)) return false;
        }

        return true;
      });
      console.log(`Units matching all filters: ${filteredUnits.length}`);

      for (const unit of filteredUnits) {
        const price = unit.startingAtPricesUnfurnished?.prices?.totalPrice || unit.startingAtPricesUnfurnished?.prices?.price || 0;
        allScrapedUnits[unit.unitId] = price;
        
        // If not seen before, mark as new
        if (!(unit.unitId in seenListings)) {
          newUnits.push({ unit, communityName, isPriceDrop: false, oldPrice: null });
        } else {
          // Check for price drop
          const oldPrice = seenListings[unit.unitId];
          if (oldPrice > 0 && price > 0 && price < oldPrice) {
            newUnits.push({ unit, communityName, isPriceDrop: true, oldPrice });
          }
        }
        // Update price in database
        seenListings[unit.unitId] = price;
      }
    } catch (err) {
      console.error(`❌ Error scraping target ${target.name}:`, err.message);
    }
  }

  // 4. Handle notifications based on run state
  if (isFirstRun) {
    console.log('First run: Saving all current listings to database without triggering individual alerts.');
    fs.writeFileSync(seenListingsPath, JSON.stringify(allScrapedUnits, null, 2));
    await sendInitNotification(webhookUrl, Object.keys(allScrapedUnits).length);
  } else {
    if (newUnits.length > 0) {
      console.log(`Found ${newUnits.length} new listings or price drops! Sending notifications...`);
      for (const item of newUnits) {
        await sendDiscordNotification(webhookUrl, item.unit, item.communityName, item.isPriceDrop, item.oldPrice);
      }
    } else {
      console.log('No new listings or price drops found in this run.');
    }
    // Always save updated database to capture price changes (increases) and migrations
    fs.writeFileSync(seenListingsPath, JSON.stringify(seenListings, null, 2));
    console.log('Database saved.');
  }
}

main().catch(err => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});
