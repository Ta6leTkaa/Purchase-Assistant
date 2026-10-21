import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',workers:1,reporter:'list',use:{trace:'off',screenshot:'off'}});
