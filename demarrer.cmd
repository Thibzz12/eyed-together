@echo off
REM Lance EyeD Together en local et ouvre le navigateur deja connecte.
REM Double-clic depuis l'explorateur, ou "demarrer.cmd" depuis un terminal.
REM
REM Le rechargement automatique n'est PAS active : il ne prend pas de facon
REM fiable sous Windows, et un serveur qui sert silencieusement l'ancien code
REM fait perdre plus de temps qu'un Ctrl+C. Apres une modification de code
REM Python, coupe cette fenetre et relance ce script.

setlocal
cd /d "%~dp0backend"

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   L'environnement virtuel est introuvable : backend\.venv
  echo   Cree-le d'abord :  python -m venv .venv
  echo   puis :             .venv\Scripts\python.exe -m pip install -r requirements-dev.txt
  echo.
  pause
  exit /b 1
)

echo.
echo   EyeD Together demarre sur http://127.0.0.1:8000
echo   Connexion de developpement : http://127.0.0.1:8000/auth/dev-login
echo   Ctrl+C pour arreter.
echo.

REM Laisse au serveur le temps d'ouvrir le port avant d'ouvrir le navigateur.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://127.0.0.1:8000/auth/dev-login"

.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
