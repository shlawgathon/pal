import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      keyframes: {
        'slide-in-from-top': {
          '0%': { opacity: '0', transform: 'translateY(-50px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-from-bottom': {
          '0%': { opacity: '0', transform: 'translateY(50px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-from-left': {
          '0%': { opacity: '0', transform: 'translateX(-80px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-in-from-right': {
          '0%': { opacity: '0', transform: 'translateX(80px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'slide-out-to-top': {
          '0%': { opacity: '1', transform: 'translateY(0)' },
          '100%': { opacity: '0', transform: 'translateY(-50px)' },
        },
        'slide-out-to-bottom': {
          '0%': { opacity: '1', transform: 'translateY(0)' },
          '100%': { opacity: '0', transform: 'translateY(50px)' },
        },
        'slide-out-to-left': {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(-80px)' },
        },
        'slide-out-to-right': {
          '0%': { opacity: '1', transform: 'translateX(0)' },
          '100%': { opacity: '0', transform: 'translateX(80px)' },
        },
      },
      animation: {
        'slide-in-from-top': 'slide-in-from-top 0.4s ease-out',
        'slide-in-from-bottom': 'slide-in-from-bottom 0.4s ease-out',
        'slide-in-from-left': 'slide-in-from-left 0.4s ease-out',
        'slide-in-from-right': 'slide-in-from-right 0.4s ease-out',
        'slide-out-to-top': 'slide-out-to-top 0.4s ease-out forwards',
        'slide-out-to-bottom': 'slide-out-to-bottom 0.4s ease-out forwards',
        'slide-out-to-left': 'slide-out-to-left 0.4s ease-out forwards',
        'slide-out-to-right': 'slide-out-to-right 0.4s ease-out forwards',
      },
    },
  },
};

export default config;
