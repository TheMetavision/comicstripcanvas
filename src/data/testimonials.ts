export interface Testimonial {
  id: string;
  name: string;
  location: string;
  rating: number;
  quote: string;
  product: string;
}

export const testimonials: Testimonial[] = [
  {
    id: '1',
    name: 'Emma R.',
    location: 'Manchester',
    rating: 5,
    quote: "I ordered a Comic Icons canvas of The Godfather for my husband's birthday. The quality is incredible and the bold style makes such a statement on our wall. He can't stop showing it off.",
    product: 'Comic Icons Canvas',
  },
  {
    id: '2',
    name: 'James & Sophie L.',
    location: 'London',
    rating: 5,
    quote: 'I had our wedding photo turned into a Comic Book Cover. The proof came back in less than 48 hours, and the team worked with me on tiny tweaks until it was perfect. Our friends were blown away.',
    product: 'Personalised Comic Book Cover',
  },
  {
    id: '3',
    name: 'Tom S.',
    location: 'Bristol',
    rating: 5,
    quote: 'The Jimi Hendrix Comic Strip canvas is pure art! Bright, punchy colours and a brilliant layout that feels straight out of a vintage comic book. Delivery was super quick too.',
    product: 'Comic Strip Canvas',
  },
  {
    id: '4',
    name: 'Hannah G.',
    location: 'Glasgow',
    rating: 5,
    quote: 'I uploaded a picture of our French Bulldog, and the team turned it into a hilarious Comic Icon print complete with a speech bubble. It\'s become a talking point for every visitor.',
    product: 'Personalised Comic Icon',
  },
  {
    id: '5',
    name: 'Khalid A.',
    location: 'Birmingham',
    rating: 5,
    quote: 'I bought the Arsenal Invincibles cover and the detail is spot on. It captures the era perfectly, and the frame finish is high quality. Will definitely be ordering more.',
    product: 'Comic Book Cover Canvas',
  },
];
