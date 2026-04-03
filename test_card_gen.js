
function generateLuhnCheckDigit(number) {
    let sum = 0;
    let shouldDouble = true;
    for (let i = number.length - 1; i >= 0; i--) {
        let digit = parseInt(number.charAt(i));
        if (shouldDouble) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        shouldDouble = !shouldDouble;
    }
    return (10 - (sum % 10)) % 10;
}

function generateCardsFromBin(bin, qty) {
    const cards = [];
    const cleanBin = bin.replace(/\D/g, '');
    
    // Detect Card Type Length
    // Amex (34, 37) = 15 digits
    // Others = 16 digits
    const isAmex = cleanBin.startsWith('34') || cleanBin.startsWith('37');
    const targetLength = isAmex ? 15 : 16;
    const baseLength = targetLength - 1;

    for (let i = 0; i < qty; i++) {
        let cardBase = cleanBin;
        while (cardBase.length < baseLength) {
            cardBase += Math.floor(Math.random() * 10);
        }
        // If the BIN is already longer than baseLength, truncate it to baseLength
        if (cardBase.length > baseLength) {
            cardBase = cardBase.substring(0, baseLength);
        }

        const checkDigit = generateLuhnCheckDigit(cardBase);
        const cardNum = cardBase + checkDigit;
        
        const mm = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
        const yy = Math.floor(Math.random() * (2032 - 2025) + 2025).toString().slice(-2);
        const cvv = isAmex 
            ? String(Math.floor(Math.random() * 9000) + 1000) 
            : String(Math.floor(Math.random() * 900) + 100);
        cards.push(`${cardNum}|${mm}|${yy}|${cvv}`);
    }
    return cards;
}

console.log("Testing Amex (374355):");
const amexCards = generateCardsFromBin('374355', 3);
amexCards.forEach(c => console.log(c));

console.log("\nTesting Visa (424242):");
const visaCards = generateCardsFromBin('424242', 3);
visaCards.forEach(c => console.log(c));
