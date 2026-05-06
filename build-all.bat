@echo off
setlocal EnableDelayedExpansion

set JAVA_HOME=C:\Program Files\Java\jdk-21
set PATH=%JAVA_HOME%\bin;%PATH%
set JAVA_OPTS=
set GRADLE_OPTS=

echo.
echo ============================================================
echo   3DCALC - Build EXE + APK Debug
echo ============================================================
echo.

:: -- Lee version de package.json (busca "version": "x.y.z")
for /f "tokens=2 delims=:, " %%v in ('findstr /r "\"version\"" package.json') do (
    set VERSION=%%~v
)
echo Version detectada: %VERSION%
echo.

:: ============================================================
:: 1. Vite build (compartido por EXE y APK)
:: ============================================================
echo [1/4] Compilando frontend (vite build)...
call npx vite build
if %errorlevel% neq 0 (
    echo ERROR: vite build fallo.
    pause & exit /b 1
)
echo      OK
echo.

:: ============================================================
:: 2. Electron - EXE (installer + portable)
:: ============================================================
echo [2/4] Empaquetando EXE con electron-builder...
call npx electron-builder --win nsis portable
if %errorlevel% neq 0 (
    echo ERROR: electron-builder fallo.
    pause & exit /b 1
)
echo      OK - dist-electron\3DCALC Setup %VERSION%.exe
echo      OK - dist-electron\3DCALC-Portable-%VERSION%.exe
echo.

:: ============================================================
:: 3. Capacitor sync Android
:: ============================================================
echo [3/4] Sincronizando Capacitor con Android...
call npx cap sync android
if %errorlevel% neq 0 (
    echo ERROR: cap sync fallo.
    pause & exit /b 1
)
echo      OK
echo.

:: ============================================================
:: 4. Gradle - APK debug
:: ============================================================
echo [4/4] Compilando APK debug con Gradle (JDK 21)...
cd android
call gradlew.bat assembleDebug --no-daemon
if %errorlevel% neq 0 (
    echo ERROR: Gradle assembleDebug fallo.
    cd ..
    pause & exit /b 1
)
cd ..
echo      OK - android\app\build\outputs\apk\debug\app-debug.apk
echo.

:: ============================================================
:: Resumen
:: ============================================================
echo ============================================================
echo   BUILD COMPLETADO - v%VERSION%
echo ============================================================
echo.
echo   EXE installer : dist-electron\3DCALC Setup %VERSION%.exe
echo   EXE portable  : dist-electron\3DCALC-Portable-%VERSION%.exe
echo   APK debug     : android\app\build\outputs\apk\debug\app-debug.apk
echo.
pause
