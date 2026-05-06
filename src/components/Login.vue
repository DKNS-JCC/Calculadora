<script setup>
import { ref, computed } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import Message from 'primevue/message'
import SelectButton from 'primevue/selectbutton'

const emit = defineEmits(['login-success'])

const empresa = ref('3DCC')
const email = ref('')
const password = ref('')
const loading = ref(false)
const errorMsg = ref('')

const empresaOptions = ['3DCC', 'SILAB3D']

const canSubmit = computed(() => email.value.trim() && password.value && empresa.value)

async function handleLogin() {
    if (!canSubmit.value) return
    loading.value = true
    errorMsg.value = ''

    try {
        const { loginWithEmail, saveUserEmpresa } = await import('../firebase')
        const user = await loginWithEmail(email.value.trim(), password.value)
        // Persist the user→empresa mapping (skips write if unchanged)
        await saveUserEmpresa(user.uid, empresa.value, user.email)
        emit('login-success', { uid: user.uid, email: user.email, empresa: empresa.value })
    } catch (e) {
        console.error('Login error:', e)
        if (e.code === 'auth/invalid-credential' || e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found') {
            errorMsg.value = 'Correo o contraseña incorrectos.'
        } else if (e.code === 'auth/invalid-email') {
            errorMsg.value = 'El correo no es válido.'
        } else if (e.code === 'auth/too-many-requests') {
            errorMsg.value = 'Demasiados intentos. Espera un momento.'
        } else if (e.code === 'auth/network-request-failed') {
            errorMsg.value = 'Sin conexión a internet.'
        } else {
            errorMsg.value = e.message || 'Error desconocido.'
        }
    } finally {
        loading.value = false
    }
}
</script>

<template>
    <div class="flex items-center justify-center h-screen bg-[#f5f5f7] dark:bg-[#0d0d0d]">
        <div class="w-full max-w-sm p-8 rounded-3xl card shadow-xl">
            <!-- Header -->
            <div class="text-center mb-8">
                <i class="pi pi-calculator text-4xl text-primary-400 mb-3 block" />
                <h1 class="text-2xl font-bold text-surface-900 dark:text-surface-0">3DCALC</h1>
                <p class="text-surface-500 dark:text-surface-400 text-sm mt-1">Inicia sesión para continuar</p>
            </div>

            <!-- Empresa selector -->
            <div class="mb-6">
                <label class="block text-surface-600 dark:text-surface-300 text-sm font-medium mb-2">Empresa</label>
                <SelectButton
                    v-model="empresa"
                    :options="empresaOptions"
                    :allowEmpty="false"
                    class="w-full flex"
                />
            </div>

            <!-- Email -->
            <div class="mb-4">
                <label class="block text-surface-600 dark:text-surface-300 text-sm font-medium mb-2">Correo electrónico</label>
                <InputText
                    v-model="email"
                    type="email"
                    placeholder="correo@ejemplo.com"
                    class="w-full"
                    @keyup.enter="handleLogin"
                />
            </div>

            <!-- Password -->
            <div class="mb-6">
                <label class="block text-surface-600 dark:text-surface-300 text-sm font-medium mb-2">Contraseña</label>
                <InputText
                    v-model="password"
                    type="password"
                    placeholder="••••••••"
                    class="w-full"
                    :feedback="false"
                    @keyup.enter="handleLogin"
                />
            </div>

            <!-- Error -->
            <Message v-if="errorMsg" severity="error" class="mb-4" :closable="false">
                {{ errorMsg }}
            </Message>

            <!-- Submit -->
            <Button
                label="Iniciar Sesión"
                icon="pi pi-sign-in"
                class="w-full"
                :loading="loading"
                :disabled="!canSubmit"
                @click="handleLogin"
            />
        </div>
    </div>
</template>
