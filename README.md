# Wallt PoC (Web AR)

PoC для примерки картины на реальной стене через WebAR в мобильном браузере.

## Что реализовано
- Запуск AR-сессии из браузера телефона.
- Поиск поверхности через WebXR hit-test.
- Размещение картины по найденной поверхности или кнопкой "Поставить картину" (fallback).
- Изменение масштаба картины в реальном времени.
- Повторное размещение кнопкой "Переместить заново".

## Файлы
- `index.html` - интерфейс и точка входа.
- `app.js` - AR-логика на three.js + WebXR.
- `styles.css` - стили интерфейса.
- `Mona_Lisa.jpg` - изображение картины.
- `.github/workflows/deploy-pages.yml` - автодеплой на GitHub Pages.

## Публикация на GitHub Pages

### 1) Создать репозиторий на GitHub
Создайте пустой репозиторий, например `wallt-poc`.

### 2) Инициализировать git и отправить код
Выполните в папке проекта:

```bash
cd /mnt/c/Users/artur/IdeaProjects/wallt-poc
git init
git branch -M main
git add .
git commit -m "Initial WebAR PoC"
git remote add origin https://github.com/<YOUR_USER>/wallt-poc.git
git push -u origin main
```

### 3) Включить GitHub Pages
В репозитории GitHub:
1. `Settings` -> `Pages`.
2. В разделе `Build and deployment` выберите `Source: GitHub Actions`.

После следующего push workflow развернет сайт. Ссылка обычно:
`https://<YOUR_USER>.github.io/wallt-poc/`

## Локальный запуск (опционально)
Если нужно запустить без деплоя:

```bash
cd /mnt/c/Users/artur/IdeaProjects/wallt-poc
python3 -m http.server 8080
```

Открыть на телефоне в той же сети:
`http://<IP-вашего-компьютера>:8080`

## Требования
- Android-устройство с поддержкой ARCore.
- Браузер с WebXR AR (обычно Chrome).

## Ограничения PoC
- Качество определения именно вертикальной стены зависит от устройства и WebXR-реализации.
- На iOS/Safari WebXR AR обычно недоступен.
