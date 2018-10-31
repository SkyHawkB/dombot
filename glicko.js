function glick_g(phi_j) {
    return 1/(Math.sqrt(1+3*((phi_j/Math.PI)**2)));
}


function glick_E(mu,mu_j,phi_j) {
    return 1/(1+Math.exp(-glick_g(phi_j)*(mu-mu_j)));
}

function glick_E_sum_prime(mu,mu_j,phi_j) {
    const d=0.00000001;
    var glick_sum=0;
    for(i=0;i<mu_j.length;i++) {
        glick_sum+=glick_E(mu+d,mu_j[i],phi_j[i])-glick_E(mu,mu_j[i],phi_j[i]);
    }
    return glick_sum/d;
}

function glick_perf(results,mu,a=-4,b=5) {
    var c=(a+b)/2;
    var j=0;
    const tolerance=0.0000001;
    var f_c = 0;
    var f_a = 0;
    while(Math.abs(c-a) > tolerance) {
        for(i=0;i<results.length;i++) {
            f_c+=results[i].win - glick_E(c,results[i].mu,results[i].phi);
            f_a+=results[i].win - glick_E(a,results[i].mu,results[i].phi);
            j++;
            if(Math.sign(f_c)==Math.sign(f_a)) {
                a=c;
            } else {
                b=c;
            }
            c=(a+b)/2;
        }
    }
    return(c);
}

function glick_f(x, delta, phi, v, tau, a) {
    return (Math.exp(x)*(delta**2 - phi**2 - v -Math.exp(x)))/(2*(phi**2 + v + Math.exp(x)))**2 -((x-a)/(tau**2));
}

module.exports={
    expectedWins: function (mu,results) {
        var expectedWins=0;
        var wins=0;
        for(i=0;i<results.length;i++) {
            wins+=results[i].win;
            expectedWins+=glick_E(mu,results[i].mu,results[i].phi);
        }
        return({played:results.length,wins:wins,expected:expectedWins});
    },
    update: function (mu,phi,sigma,tau,results) {
        // Results is an object with mu, phi, win
        var v_sum=0;
        for(i=0;i<results.length;i++) {
            v_sum+=glick_g(results[i].phi)**2*glick_E(mu,results[i].mu,results[i].phi)*(1-glick_E(mu,results[i].mu,results[i].phi));
        }
        v=1/v_sum; 
        var delta=0;
        for(i=0;i<results.length;i++) {
            delta+=v*(glick_g(results[i].phi)*(results[i].win-glick_E(mu,results[i].mu,results[i].phi)));
        }
        var a=Math.log(sigma**2);
        var A=a;
        var B;                
        if(delta**2 > (phi**2 + v)) {
            B = Math.log(delta**2 - phi**2 -v);
        } else {
            var k=1;
            while(glick_f(a-k*tau,delta,phi,v,tau,a) < 0) {
                k=k+1
            }
            B=a-k*tau;
        }
        var fa = glick_f(A,delta,phi,v,tau,a);
        var fb = glick_f(B,delta,phi,v,tau,a);

        while(Math.abs(B-A)>0.0000001) {
            var C = A + ((A-B)*fa)/(fb-fa);
            var fc = glick_f(C,delta,phi,v,tau,a);

            if(fc*fb<0) {
                A=B;
                fa=fb;
            } else {
                fa=fa/2;
            }
            B=C;
            fb=fc;
        }

        var sigma_prime=Math.exp(A/2);
        phi_star=Math.sqrt(phi**2 + sigma_prime**2);
        phi_prime=1/(Math.sqrt(1/(phi_star**2)+1/v));
        var mu_prime=mu;
        for(i=0;i<results.length;i++) {
            mu_prime+=phi_prime**2*glick_g(results[i].phi)*(results[i].win-glick_E(mu,results[i].mu,results[i].phi));
        }
        return {mu:mu_prime,phi:phi_prime,sigma:sigma_prime};
    }  
};
/* testing
   my_results= [ {'mu':0.8,'phi':0.2,'win':1},
   {'mu':1.29,'phi':0.18,'win':1},
   {'mu':1.29,'phi':0.13,'win':1},
   {'mu':1.29,'phi':0.13,'win':1}];

   console.log(my_results);

   console.log(glick_g(0.2));
   console.log(glick_E(1.5,0.2,0.2));
   console.log(glicko_update(1.3021,0.172, 0.0330290,0.4,my_results));
   console.log(glick_perf(my_results,1.3021));
   */
