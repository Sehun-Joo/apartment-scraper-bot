/**
 * Sends a Discord Webhook notification with details about a new apartment unit.
 * @param {string} webhookUrl - The Discord Webhook URL.
 * @param {object} unit - The unit data object from Avalon Communities API.
 * @param {string} communityName - The name of the community (e.g. AVA DoBro).
 * @param {boolean} isPriceDrop - Whether this is a price drop alert.
 * @param {number} oldPrice - The previous price, if applicable.
 */
export async function sendDiscordNotification(webhookUrl, unit, communityName, isPriceDrop = false, oldPrice = null) {
  if (!webhookUrl) {
    console.warn('DISCORD_WEBHOOK_URL is not set. Skipping notification.');
    return;
  }

  const basePrice = unit.startingAtPricesUnfurnished?.prices?.price;
  const totalPrice = unit.startingAtPricesUnfurnished?.prices?.totalPrice;
  const netEffective = unit.startingAtPricesUnfurnished?.prices?.netEffectivePrice;
  
  let priceStr = 'Contact for pricing';
  if (totalPrice) {
    if (isPriceDrop && oldPrice) {
      priceStr = `~~$${oldPrice.toLocaleString()}~~ ➡️ **$${totalPrice.toLocaleString()}/mo** (Total)`;
    } else {
      priceStr = `**$${totalPrice.toLocaleString()}/mo** (Total)`;
    }
    if (netEffective && netEffective < totalPrice) {
      priceStr += `\n*$${netEffective.toLocaleString()}/mo net effective*`;
    }
  } else if (basePrice) {
    priceStr = `**$${basePrice.toLocaleString()}/mo** (Base)`;
  }

  const beds = unit.bedroomNumber === 0 ? 'Studio' : `${unit.bedroomNumber} Bed`;
  const baths = `${unit.bathroomNumber} Bath`;
  let sqft = unit.squareFeet ? `${unit.squareFeet.toLocaleString()} sqft` : 'N/A';
  if (unit.squareFeet && (totalPrice || basePrice)) {
    const rent = totalPrice || basePrice;
    const annualRent = rent * 12;
    const ppsf = Math.round(annualRent / unit.squareFeet);
    sqft += `\n*$${ppsf}/ft²*`;
  }
  
  // Format availability date
  let availDate = 'Immediate';
  if (unit.availableDateUnfurnished) {
    try {
      const date = new Date(unit.availableDateUnfurnished);
      availDate = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/New_York'
      });
    } catch (e) {
      availDate = unit.availableDateUnfurnished;
    }
  }

  // Format promotion text
  let promoText = '';
  if (unit.promotions && unit.promotions.length > 0) {
    promoText = unit.promotions.map(p => `• **${p.promotionTitle}**: ${p.promotionDescription}`).join('\n');
  }

  const titlePrefix = isPriceDrop ? '📉 PRICE DROP!' : '🏢 New Listing!';
  const embed = {
    title: `${titlePrefix} ${beds} - Unit ${unit.unitName}`,
    url: unit.url || 'https://www.avaloncommunities.com',
    color: 983063, // 0x0EA5E9 (sky-500)
    fields: [
      { name: 'Community', value: communityName, inline: true },
      { name: 'Unit Name', value: unit.unitName, inline: true },
      { name: 'Price (Total)', value: priceStr, inline: true },
      { name: 'Beds / Baths', value: `${beds} / ${baths}`, inline: true },
      { name: 'Size', value: sqft, inline: true },
      { name: 'Available Date', value: availDate, inline: true }
    ],
    timestamp: new Date().toISOString(),
    footer: {
      text: 'Avalon Apartment Bot'
    }
  };

  if (promoText) {
    embed.fields.push({ name: 'Promotions', value: promoText.slice(0, 1024), inline: false });
  }

  if (unit.floorPlan?.highResolution) {
    let imgUrl = unit.floorPlan.highResolution;
    if (imgUrl.startsWith('/')) {
      imgUrl = `https://www.avaloncommunities.com${imgUrl}`;
    }
    embed.image = { url: imgUrl };
  }

  const payload = {
    username: 'Avalon Bot',
    avatar_url: 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=128&h=128&fit=crop',
    embeds: [embed]
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Discord API Error (${res.status}): ${text}`);
    } else {
      console.log(`Notification sent for Unit ${unit.unitName} ($${totalPrice || basePrice})`);
    }
  } catch (err) {
    console.error('Failed to send Discord notification:', err);
  }
}
