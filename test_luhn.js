function calculateLuhn(number) {
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
    return (sum * 9) % 10;
}

function generateLuhnCard(bin) {
    let card = bin;
    while (card.length < 15) {
        card += Math.floor(Math.random() * 10);
    }
    card += calculateLuhn(card);
    return card;
}

// Simple check
for(let i=0; i<5; i++) {
    console.log(generateLuhnCard("424242"));
}
