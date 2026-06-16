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
    'I\u2019m nice at ping pong',
    'I leave my emojis Bart Simpson color',
    'I have to dress Kim everyday so she doesn\u2019t embarrass me',
    'I need a room full of mirrors so I can be surrounded by winners.',
    'Fur pillows are hard to actually sleep on',
    'I no longer have a manager. I can\u2019t be managed',
    'Everybody knows the movie get out is about me',
    'To my fans\u2026 I can\u2019t finish the album because there\u2019s a bee in the studio',
    'Name one genius who ain\u2019t crazy',
    'I like some of the Gaga songs, what the fuck she know about cameras?',
    'George Bush doesn\u2019t care about black people',
    'You ain\u2019t got the answers, Sway!',
    'I hate when I\u2019m on a plane and I wake up with a water bottle next to me like oh great now I gotta be responsible for this water bottle',
    'My life is dope, and I do dope shit',
    'Mayonnaise-colored Benz, I push Miracle Whips'


  ];

  root.FAA_randomQuote = function () {
    const list = root.FAA_QUOTES;
    return list[Math.floor(Math.random() * list.length)];
  };
})(typeof window !== 'undefined' ? window : globalThis);
