import {test, expect, chromium} from '@playwright/test';
import {mkdtemp, cp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Test-only service worker exposes the extension ID; production has no background worker.
async function prepareExtension(folder) {
  const extension = path.join(folder, 'extension');
  await cp(path.resolve('dist/extension'), extension, {recursive:true});
  const manifest = JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
  manifest.background = {service_worker:'test-bootstrap.js'};
  await writeFile(path.join(extension,'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(extension,'test-bootstrap.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  return extension;
}
async function launch(folder, extension) {
  const context = await chromium.launchPersistentContext(path.join(folder,'browser'), {
    channel:'chromium', headless:true, acceptDownloads:true,
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  return {context, base:`chrome-extension://${new URL(worker.url()).hostname}`};
}
const password = 'Synthetic family password 42';
const newPassword = 'New synthetic family password 73';
async function addPerson(page, firstName, lastName, displayName, number, twoDocuments = false) {
  await page.getByRole('button',{name:'Добавить человека',exact:true}).click();
  const dialog = page.locator('#editor');
  await dialog.getByLabel('Имя',{exact:true}).fill(firstName);
  await dialog.getByLabel('Фамилия',{exact:true}).fill(lastName);
  await dialog.getByLabel('Название профиля, необязательно').fill(displayName);
  await dialog.getByLabel('Дата рождения').fill('1990-01-01');
  await dialog.getByRole('button',{name:'Добавить документ',exact:true}).click();
  await dialog.getByLabel('Номер (с серией, если есть)',{exact:true}).fill(number);
  if (twoDocuments) {
    await dialog.getByRole('button',{name:'Добавить документ',exact:true}).click();
    await dialog.getByLabel('Тип документа').nth(1).selectOption('international_passport');
    await dialog.getByLabel('Номер (с серией, если есть)').nth(1).fill('SYNTHETIC-FOREIGN-5678');
  }
  await dialog.getByRole('button',{name:'Сохранить человека',exact:true}).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#status')).toHaveText('Профиль сохранён.');
}

test('encrypted profiles: create, edit, popup selection, backup, password change, restart, restore, delete', async () => {
  test.setTimeout(90_000);
  const folder = await mkdtemp(path.join(tmpdir(),'purchase-profiles-test-'));
  const extension = await prepareExtension(folder);
  let context;
  try {
    let launched = await launch(folder,extension); context=launched.context;
    let page = await context.newPage(); await page.clock.install(); await page.goto(`${launched.base}/people.html`);
    await expect(page.locator('#gateTitle')).toHaveText('Создайте защищённое хранилище');
    await page.locator('#password').fill(password); await page.locator('#repeatPassword').fill(password);
    await page.getByRole('button',{name:'Создать хранилище',exact:true}).click();
    await expect(page.locator('#workspace')).toBeVisible();
    await addPerson(page,'Анна','Тестовая','Мама','SYNTHETIC-ADULT-1234',true);
    await addPerson(page,'Пётр','Тестовый','Папа','SYNTHETIC-SECOND-9876');
    await expect(page.locator('#people .card')).toHaveCount(2);
    await expect(page.locator('#people')).not.toContainText('SYNTHETIC-ADULT-1234');
    await page.locator('.card').filter({has:page.getByRole('heading',{name:'Мама',exact:true})}).getByRole('button',{name:'Изменить',exact:true}).click();
    await expect(page.locator('#editor [name=documentNumber]').first()).toHaveValue('SYNTHETIC-ADULT-1234');
    await page.locator('#editor [name=documentNumber]').first().fill('SYNTHETIC-UPDATED-1111');
    await page.getByRole('button',{name:'Сохранить человека',exact:true}).click();
    await expect(page.locator('#editor')).not.toBeVisible();
    await page.getByText('Защита и резервная копия',{exact:true}).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button',{name:'Скачать зашифрованную копию'}).click();
    const downloaded = await download;
    const backupPath = path.join(folder,'copy.json'); await downloaded.saveAs(backupPath);
    const backup = await readFile(backupPath,'utf8');
    expect(backup).not.toContain('SYNTHETIC'); expect(backup).not.toContain('Тестовая'); expect(backup).not.toContain(password);
    const raw = await page.evaluate(async () => await chrome.storage.local.get(null));
    expect(JSON.stringify(raw)).not.toContain('SYNTHETIC'); expect(Object.keys(raw)).toEqual(['purchaseAssistantVault']);
    await page.locator('#oldPassword').fill(password); await page.locator('#newPassword').fill(newPassword); await page.locator('#newPasswordRepeat').fill(newPassword);
    await page.getByRole('button',{name:'Изменить пароль',exact:true}).click();
    await expect(page.locator('#status')).toContainText('Пароль изменён');
    const popup = await context.newPage(); await popup.goto(`${launched.base}/popup.html`);
    await popup.locator('#password').fill(newPassword); await popup.getByRole('button',{name:'Разблокировать',exact:true}).click();
    await expect(popup.locator('#people .person')).toHaveCount(2);
    await expect(popup.locator('#people select').first()).toHaveValue('-1');
    await popup.locator('#people select').first().selectOption('1');
    await popup.locator('#people input[type=checkbox]').first().check();
    await expect(popup.locator('#fill')).toBeDisabled();
    await page.bringToFront();
    const second = page.locator('.card').filter({has:page.getByRole('heading',{name:'Папа',exact:true})});
    await second.getByRole('button',{name:'Удалить',exact:true}).click();
    await page.getByRole('button',{name:'Отмена',exact:true}).click(); await expect(page.locator('#people .card')).toHaveCount(2);
    await second.getByRole('button',{name:'Удалить',exact:true}).click(); await page.getByRole('button',{name:'Удалить профиль',exact:true}).click();
    await expect(page.locator('#people .card')).toHaveCount(1);
    await expect(popup.locator('#workspace')).not.toBeVisible();
    await page.getByRole('button',{name:'Заблокировать',exact:true}).click();
    await expect(page.locator('body')).not.toContainText('Тестовая');
    await context.close(); context=undefined;
    launched = await launch(folder,extension); context=launched.context;
    page = await context.newPage(); await page.clock.install(); await page.goto(`${launched.base}/people.html`);
    await expect(page.locator('#gateTitle')).toHaveText('Разблокируйте хранилище');
    await page.locator('#password').fill(password); await page.getByRole('button',{name:'Разблокировать',exact:true}).click();
    await expect(page.locator('#status')).toContainText('Неверный пароль');
    await page.locator('#password').fill(newPassword); await page.getByRole('button',{name:'Разблокировать',exact:true}).click();
    await expect(page.locator('#people .card')).toHaveCount(1);
    await page.getByText('Восстановить из резервной копии',{exact:true}).click();
    await page.locator('#backupFile').setInputFiles(backupPath); await page.locator('#backupPassword').fill(password); await page.locator('#replaceConsent').check();
    await page.getByRole('button',{name:'Восстановить и заменить профили',exact:true}).click();
    await expect(page.locator('#people .card')).toHaveCount(2);
    await page.screenshot({path:'test-results/profiles.png',fullPage:true});
    await page.getByRole('button',{name:'Заблокировать',exact:true}).click();
    await page.locator('#password').fill(password); await page.getByRole('button',{name:'Разблокировать',exact:true}).click();
    await expect(page.locator('#people .card')).toHaveCount(2);
    await page.clock.fastForward(5 * 60 * 1000 + 100);
    await expect(page.locator('#workspace')).not.toBeVisible();
    await expect(page.locator('#people')).toBeEmpty();
    await expect(page.locator('body')).not.toContainText('Тестовая');
  } finally {
    if (context) await context.close();
    await rm(folder,{recursive:true,force:true});
  }
});
