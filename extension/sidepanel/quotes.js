/**
 * auto-mate tagline quotes — one picked at random on each panel load.
 */
(function (root) {
  root.FAA_QUOTES = [
    'Sometimes I\u2019m wishin that my dick had go pro',
    'Skrt skrt skrt, like a private school for women',
    'She got a light skinned friend look like Michael Jackson',
    'She got a dark skinned friend look like Michael Jackson',
    'You left your fridge open somebody just took a sandwich',
    'WHAT THE FUCK RIGHT NOW?',
    'HURRY UP WITH MY DAMN CROISSANTS',
    'Poopity Scoop Whoopity Scoop',
    "I'm nice at ping pong",
    'I leave my emojis Bart Simpson color',
    "I have to dress Kim everyday so she doesn't embarrass me",
    'I need a room full of mirrors so I can be surrounded by winners.',
    'Fur pillows are hard to actually sleep on',
    "I no longer have a manager. I can't be managed",
    'Everybody knows the movie get out is about me',
    "To my fans\u2026 I can\u2019t finish the album because there\u2019s a bee in the studio"
  ];

  root.FAA_randomQuote = function () {
    const list = root.FAA_QUOTES;
    return list[Math.floor(Math.random() * list.length)];
  };
})(typeof window !== 'undefined' ? window : globalThis);
