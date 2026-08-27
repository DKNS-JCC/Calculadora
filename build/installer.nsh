# Override del chequeo "app en ejecución" de electron-builder (NSIS).
#
# El chequeo de serie es frágil: por PowerShell busca CUALQUIER proceso cuya
# ruta empiece por la carpeta de instalación, y tiene falsos positivos
# documentados que bloquean la instalación con "No se puede cerrar 3DCALC"
# aunque no exista ningún proceso (electron-builder issues #6865, #8131).
#
# Estrategia simple y robusta: intentar matar 3DCALC.exe por nombre exacto
# (el instalador se llama "3DCALC Setup x.y.z.exe", no le afecta) y
# CONTINUAR SIEMPRE. Si hubiera un proceso imposible de matar, NSIS avisará
# de ficheros en uso, pero nunca más el bucle infinito de "Reintentar".
!macro customCheckAppRunning
  nsExec::Exec `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Sleep 500
!macroend
