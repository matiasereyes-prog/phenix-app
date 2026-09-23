import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function generarPasswordTemporal(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pass = '';
  for (let i = 0; i < 10; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
}

async function enviarEmailPassword(to: string, nombre: string, password: string, loginUrl: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) throw new Error('RESEND_API_KEY no configurada');

  const html = `
  <div style="font-family:'Urbanist',Arial,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;padding:48px 40px;border-radius:16px">
    <div style="margin-bottom:32px">
      <img src="https://phenixleasing.com/logo.png" alt="Phenix Leasing" height="28" style="height:28px;width:auto;display:block"/>
    </div>
    <h1 style="font-family:'Poppins',Arial,sans-serif;font-size:26px;font-weight:800;color:#101010;margin:0 0 12px">Tu contraseña temporal</h1>
    <p style="font-size:16px;color:#404040;line-height:1.6;margin:0 0 24px">
      Hola ${nombre || ''}, se generó una contraseña temporal para tu cuenta. Vas a tener que cambiarla la primera vez que ingreses.
    </p>
    <div style="background:#f2f2f2;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;letter-spacing:2px;color:#101010">${password}</span>
    </div>
    <a href="${loginUrl}" style="display:inline-block;background:#0F527C;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:15px">Ingresar ahora</a>
    <p style="font-size:13px;color:#737373;line-height:1.6;margin-top:28px">
      Por seguridad, el acceso por contraseña vence cada 3 días — pasado ese plazo vas a tener que reingresar con el link de acceso por email.
    </p>
    <hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0 16px"/>
    <p style="font-size:11px;color:#a0a0a0;line-height:1.5;margin:0">
      Phenix Leasing S.A. · Este es un correo transaccional relacionado con tu cuenta.
      Si no solicitaste este acceso, podés ignorar este mensaje o
      <a href="mailto:soporte@phenixleasing.com" style="color:#a0a0a0">contactarnos</a>.
    </p>
  </div>`;

  const text = `Tu contraseña temporal — Phenix Leasing

Hola ${nombre || ''}, se generó una contraseña temporal para tu cuenta. Vas a tener que cambiarla la primera vez que ingreses.

Contraseña: ${password}

Ingresá acá: ${loginUrl}

Por seguridad, el acceso por contraseña vence cada 3 días — pasado ese plazo vas a tener que reingresar con el link de acceso por email.

—
Phenix Leasing S.A. · Este es un correo transaccional relacionado con tu cuenta.
Si no solicitaste este acceso, podés ignorar este mensaje o escribirnos a soporte@phenixleasing.com.`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Phenix Leasing <noreply@phenixleasing.com>',
      to: [to],
      subject: 'Tu contraseña temporal — Phenix Leasing',
      html,
      text,
      headers: {
        'List-Unsubscribe': '<mailto:soporte@phenixleasing.com?subject=No%20recibir%20mas%20correos>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Resend error: ' + errText);
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user } } = await supabaseUser.auth.getUser()
    if (!user) return new Response('Unauthorized', { status: 401, headers: corsHeaders })

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { action, email, nombre, rol, tipo, telefono, cuit, redirectTo, userId, contratoId, txHash, walletAddress } = await req.json()

    // Acción de auto-servicio: cualquier usuario logueado puede renovar SU PROPIO vencimiento
    // de acceso por contraseña (se llama tras un login exitoso por magic link/OTP).
    if (action === 'renovar_reauth') {
      const vence = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
      const { error: reauthError } = await supabaseAdmin.from('usuarios')
        .update({ reauth_required_at: vence })
        .eq('email', user.email) // siempre el propio email del token, nunca uno arbitrario
      if (reauthError) return new Response(JSON.stringify({ error: reauthError.message }), { status: 400, headers: corsHeaders })
      return new Response(JSON.stringify({ ok: true, reauth_required_at: vence }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Acción de auto-servicio: el cliente confirma que depositó fondos en SU PROPIO contrato
    // (verificado por usuario_id, nunca uno arbitrario). Marca el lease como activo y deja
    // registro en escrow_eventos.
    if (action === 'confirmar_deposito') {
      if (!contratoId || !txHash) return new Response(JSON.stringify({ error: 'Falta contratoId o txHash' }), { status: 400, headers: corsHeaders })

      const { data: usuario } = await supabaseAdmin.from('usuarios').select('id').eq('email', user.email).maybeSingle()
      if (!usuario) return new Response(JSON.stringify({ error: 'Usuario no encontrado' }), { status: 404, headers: corsHeaders })

      const { data: contrato } = await supabaseAdmin.from('contratos')
        .select('id, usuario_id, lease_id_onchain, tipo')
        .eq('id', contratoId).maybeSingle()

      if (!contrato || contrato.usuario_id !== usuario.id) {
        return new Response(JSON.stringify({ error: 'Este contrato no te pertenece' }), { status: 403, headers: corsHeaders })
      }
      if (contrato.tipo !== 'escrow_blockchain') {
        return new Response(JSON.stringify({ error: 'Este contrato no es de tipo escrow blockchain' }), { status: 400, headers: corsHeaders })
      }

      await supabaseAdmin.from('contratos').update({ estado: 'activo' }).eq('id', contratoId)
      await supabaseAdmin.from('escrow_eventos').insert({
        contrato_id: contratoId,
        lease_id_onchain: contrato.lease_id_onchain,
        tipo_evento: 'fondos_depositados',
        tx_hash: txHash,
        actor_wallet: walletAddress || null,
        actor_usuario_email: user.email
      })

      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Todas las demás acciones son administrativas — requieren rol admin
    const { data: perfil } = await supabaseUser.from('usuarios')
      .select('rol').eq('email', user.email).maybeSingle()

    if (!perfil || perfil.rol !== 'admin') {
      return new Response('Forbidden — solo admins', { status: 403, headers: corsHeaders })
    }

    if (action === 'create_user') {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { nombre, tipo }
      })
      if (authError && !authError.message.includes('already been registered')) {
        return new Response(JSON.stringify({ error: authError.message }), { status: 400, headers: corsHeaders })
      }

      const { error: dbError } = await supabaseAdmin.from('usuarios').upsert({
        auth_id: authData?.user?.id || null,
        email, nombre, rol, tipo,
        telefono: telefono || null,
        cuit: cuit || null
      }, { onConflict: 'email' })
      if (dbError) return new Response(JSON.stringify({ error: dbError.message }), { status: 400, headers: corsHeaders })

      await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
        },
        body: JSON.stringify({ email, create_user: false, options: { emailRedirectTo: redirectTo } })
      })

      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    } else if (action === 'delete_user') {
      await supabaseAdmin.auth.admin.deleteUser(userId)
      await supabaseAdmin.from('usuarios').update({ activo: false }).eq('id', userId)
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    } else if (action === 'resend_magic_link') {
      await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
        },
        body: JSON.stringify({ email, create_user: false, options: { emailRedirectTo: redirectTo } })
      })
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    } else if (action === 'set_temp_password') {
      // userId acá es el auth_id (uuid de Supabase Auth), no el id de la tabla usuarios
      if (!userId || !email) {
        return new Response(JSON.stringify({ error: 'Falta userId o email' }), { status: 400, headers: corsHeaders })
      }

      const { data: existingUser, error: getError } = await supabaseAdmin.auth.admin.getUserById(userId)
      if (getError || !existingUser?.user) {
        return new Response(JSON.stringify({ error: 'Usuario no encontrado en Auth' }), { status: 404, headers: corsHeaders })
      }

      const tempPassword = generarPasswordTemporal()

      const { error: updError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        password: tempPassword,
        user_metadata: {
          ...existingUser.user.user_metadata,
          must_change_password: true,
        }
      })
      if (updError) return new Response(JSON.stringify({ error: updError.message }), { status: 400, headers: corsHeaders })

      try {
        await enviarEmailPassword(email, nombre, tempPassword, redirectTo || 'https://app.phenixleasing.com')
      } catch (mailErr) {
        return new Response(JSON.stringify({ ok: true, warning: 'Password seteada pero falló el envío de mail: ' + mailErr.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    return new Response('Action not found', { status: 400, headers: corsHeaders })

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
